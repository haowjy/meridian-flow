package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"golang.org/x/net/websocket"
	"meridian/internal/httputil"
)

// --- ConnectProject handler ---

// ConnectProject upgrades and serves a project-scoped websocket connection.
// GET /ws/projects/{projectId}
func (h *CollabHandler) ConnectProject(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project identifier")
	if !ok {
		return
	}

	projectUUID, err := parseUUID(strings.TrimSpace(projectID))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Project identifier must be a valid UUID")
		return
	}
	canonicalProjectID := projectUUID.String()

	wsServer := websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler: func(conn *websocket.Conn) {
			h.handleProjectSocket(r.Context(), canonicalProjectID, conn)
		},
	}
	wsServer.ServeHTTP(w, r)
}

func (h *CollabHandler) handleProjectSocket(ctx context.Context, projectID string, conn *websocket.Conn) {
	wsConn := newWebsocketDocumentConnection(conn)
	defer func() {
		_ = wsConn.Close()
	}()

	conn.MaxPayloadBytes = collabMaxMessageBytes

	// Auth bootstrap via authenticator
	authResult, authErr := h.authenticator.bootstrapAuth(conn, projectID)
	if authResult == nil {
		h.sendError(wsConn, "AUTH_FAILED", authErr)
		return
	}

	userID := authResult.UserID
	userUUID := authResult.UserUUID
	h.logger.Info("project websocket authenticated",
		"project_id", projectID,
		"user_id", userID,
		"connection_id", wsConn.ID(),
	)

	// Signal auth success so the client knows it's safe to send commands.
	if err := wsConn.SendJSON(struct {
		Type string `json:"type"`
	}{Type: wsTypeProjectConnected}); err != nil {
		h.logger.Debug("project ws failed to send project:connected",
			"project_id", projectID,
			"error", err,
		)
		return
	}

	registry := newProjectSubscriptionRegistry(projectMaxDocSubscriptions)
	defer h.cleanupProjectSubscriptions(ctx, registry, projectID, wsConn.ID())

	heartbeatAcks := make(chan struct{}, 1)
	heartbeatStop := make(chan struct{})
	go h.runHeartbeatLoop(wsConn, heartbeatAcks, heartbeatStop)
	defer close(heartbeatStop)

	// Run the shared message loop with project-specific handlers
	runMessageLoop(conn, wsConn, messageLoopHandlers{
		onTextMessage: func(raw []byte) bool {
			return h.handleProjectTextMessage(ctx, wsConn, projectID, userID, userUUID, raw, heartbeatAcks, registry)
		},
		onBinaryMessage: func(raw []byte) {
			h.handleProjectBinaryMessage(ctx, wsConn, projectID, userID, raw, registry)
		},
	}, messageLoopConfig{
		logContext: []any{"project_id", projectID},
	}, h.logger)
}

// handleProjectTextMessage handles JSON messages on the project websocket.
// Returns true if the message was handled (even if it resulted in an error).
func (h *CollabHandler) handleProjectTextMessage(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	userUUID uuid.UUID,
	raw []byte,
	heartbeatAcks chan<- struct{},
	registry *projectSubscriptionRegistry,
) bool {
	msgType, ok := tryParseTypedMessage(raw)
	if !ok {
		return false
	}

	switch msgType {
	case wsTypeHeartbeat:
		nonBlockingSignal(heartbeatAcks)
		return true

	case wsTypeDocSubscribe:
		h.handleDocSubscribe(ctx, conn, projectID, userID, raw, registry)
		return true

	case wsTypeDocUnsubscribe:
		h.handleDocUnsubscribe(ctx, conn, raw, registry)
		return true

	case wsTypeProposalAccept, wsTypeProposalReject, wsTypeProposalGroupAccept:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, registry, msgType)
		return true

	default:
		// Ignore unknown JSON message types for forward compatibility.
		return true
	}
}

// handleDocSubscribe processes a doc:subscribe command.
func (h *CollabHandler) handleDocSubscribe(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	raw []byte,
	registry *projectSubscriptionRegistry,
) {
	var cmd docSubscribeCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendDocError(conn, "", "INVALID_PAYLOAD", "invalid doc:subscribe payload")
		return
	}

	documentID := strings.TrimSpace(cmd.DocumentID)
	if documentID == "" {
		h.sendDocError(conn, "", "INVALID_DOCUMENT_ID", "documentId is required")
		return
	}

	docUUID, err := parseUUID(documentID)
	if err != nil {
		h.sendDocError(conn, documentID, "INVALID_DOCUMENT_ID", "documentId must be a valid UUID")
		return
	}
	canonicalDocumentID := docUUID.String()

	// Idempotent: if already subscribed, just re-ack
	if _, alreadySubscribed := registry.get(canonicalDocumentID); alreadySubscribed {
		err := conn.SendJSON(docSubscribedEvent{
			Type:       wsTypeDocSubscribed,
			DocumentID: canonicalDocumentID,
		})
		if err != nil && !errors.Is(err, io.EOF) {
			h.logger.Debug("project ws failed to send doc:subscribed",
				"project_id", projectID,
				"document_id", canonicalDocumentID,
				"error", err,
			)
		}
		return
	}

	// Verify access via authenticator
	if errCode, errMsg := h.authenticator.checkDocumentAccess(ctx, projectID, userID, canonicalDocumentID); errCode != "" {
		h.sendDocError(conn, canonicalDocumentID, errCode, errMsg)
		return
	}

	// Check subscription limit
	sub := &projectDocSubscription{
		docID:   canonicalDocumentID,
		docUUID: docUUID,
	}
	if err := registry.add(sub); err != nil {
		h.sendDocError(conn, canonicalDocumentID, "SUBSCRIPTION_LIMIT", fmt.Sprintf("max %d concurrent subscriptions", projectMaxDocSubscriptions))
		return
	}

	// Acquire session
	session, err := h.sessionManager.Acquire(ctx, canonicalDocumentID)
	if err != nil {
		h.logger.Error("project ws session acquire failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		registry.remove(canonicalDocumentID)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to initialize document session")
		return
	}
	sub.session = session

	// Create multiplexed connection adapter and subscribe to broadcaster
	muxConn := newMultiplexedConnection(conn)
	sub.conn = muxConn
	if err := h.documentBroadcaster.Subscribe(canonicalDocumentID, muxConn); err != nil {
		h.logger.Error("project ws broadcaster subscribe failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.sessionManager.Release(releaseCtx, canonicalDocumentID); err != nil {
			h.logger.Error("project ws session release failed after subscribe error",
				"project_id", projectID,
				"document_id", canonicalDocumentID,
				"error", err,
			)
		}
		registry.remove(canonicalDocumentID)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to subscribe to document")
		return
	}

	// Send initial sync sequence:
	// 1. sync-step1 binary frame (multiplexed)
	serverStep1Payload, err := session.BuildSyncStep1Payload()
	if err != nil {
		h.logger.Error("project ws sync-step1 build failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.teardownSubscription(ctx, canonicalDocumentID, registry)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to build sync state")
		return
	}
	if err := conn.Send(frameEnvelope(collabEnvelopeSyncStep1, docUUID, serverStep1Payload)); err != nil {
		h.teardownSubscription(ctx, canonicalDocumentID, registry)
		return
	}

	// 2. proposal:snapshot JSON
	if err := h.sendProposalSnapshot(ctx, conn, docUUID); err != nil {
		h.logger.Error("project ws proposal snapshot failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.teardownSubscription(ctx, canonicalDocumentID, registry)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to load proposal snapshot")
		return
	}

	// 3. doc:subscribed (terminal ack)
	err = conn.SendJSON(docSubscribedEvent{
		Type:       wsTypeDocSubscribed,
		DocumentID: canonicalDocumentID,
	})
	if err != nil && !errors.Is(err, io.EOF) {
		h.logger.Debug("project ws failed to send doc:subscribed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
	}
}

// handleDocUnsubscribe processes a doc:unsubscribe command.
func (h *CollabHandler) handleDocUnsubscribe(
	ctx context.Context,
	conn *websocketDocumentConnection,
	raw []byte,
	registry *projectSubscriptionRegistry,
) {
	var cmd docUnsubscribeCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		h.sendDocError(conn, "", "INVALID_PAYLOAD", "invalid doc:unsubscribe payload")
		return
	}

	documentID := strings.TrimSpace(cmd.DocumentID)
	canonicalDocumentID := documentID
	if parsed, err := parseUUID(documentID); err == nil {
		canonicalDocumentID = parsed.String()
	}

	// Safe if not subscribed
	h.teardownSubscription(ctx, canonicalDocumentID, registry)
	h.sendDocUnsubscribed(conn, canonicalDocumentID, nil)
}

// handleProjectBinaryMessage routes multiplexed binary frames to the correct document subscription.
func (h *CollabHandler) handleProjectBinaryMessage(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	rawMessage []byte,
	registry *projectSubscriptionRegistry,
) {
	envelopeType, framedDocUUID, payload, err := unframeEnvelope(rawMessage)
	if err != nil {
		h.logger.Warn("project ws frame parse failed",
			"project_id", projectID,
			"connection_id", conn.ID(),
			"error", err,
		)
		// Don't close the socket — just drop the malformed frame
		return
	}

	documentID := framedDocUUID.String()
	sub, ok := registry.get(documentID)
	if !ok {
		h.sendDocError(conn, documentID, "NOT_SUBSCRIBED", "document is not subscribed on this connection")
		return
	}
	// Re-validate on active traffic so stale access/project scope is cleaned up quickly.
	if reason, invalid := h.authenticator.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
		h.teardownSubscription(ctx, documentID, registry)
		h.sendDocUnsubscribed(conn, documentID, &reason)
		return
	}

	switch envelopeType {
	case collabEnvelopeSyncStep1, collabEnvelopeSyncStep2, collabEnvelopeUpdate:
		syncType, responsePayload, updatePayload, err := sub.session.HandleSyncPayload(ctx, payload, conn.ID())
		if err != nil {
			h.logger.Warn("project ws sync message handling failed",
				"project_id", projectID,
				"document_id", documentID,
				"connection_id", conn.ID(),
				"error", err,
			)
			h.sendDocError(conn, documentID, "SYNC_ERROR", "document sync failed")
			return
		}

		if !envelopeMatchesSyncType(envelopeType, syncType) {
			h.logger.Warn("project ws envelope/sync type mismatch",
				"project_id", projectID,
				"document_id", documentID,
				"connection_id", conn.ID(),
				"envelope_type", envelopeType,
				"sync_type", syncType,
			)
			h.sendDocError(conn, documentID, "SYNC_ERROR", "envelope/sync type mismatch")
			return
		}

		if envelopeType == collabEnvelopeSyncStep1 && len(responsePayload) == 0 {
			h.logger.Warn("project ws sync-step1 produced empty response",
				"project_id", projectID,
				"document_id", documentID,
				"connection_id", conn.ID(),
			)
			h.sendDocError(conn, documentID, "SYNC_ERROR", "document sync-step1 produced empty response")
			return
		}

		// Send response envelope back to this client
		if len(responsePayload) > 0 {
			responseEnvelope, err := envelopeTypeFromSyncPayload(responsePayload)
			if err != nil {
				h.logger.Warn("project ws response envelope parse failed",
					"project_id", projectID,
					"document_id", documentID,
					"connection_id", conn.ID(),
					"error", err,
				)
				h.sendDocError(conn, documentID, "SYNC_ERROR", "failed to parse response envelope")
				return
			}
			if err := conn.Send(frameEnvelope(responseEnvelope, framedDocUUID, responsePayload)); err != nil {
				return
			}
		}

		// On SyncStep1, also send server's SyncStep1
		if envelopeType == collabEnvelopeSyncStep1 && syncType == ycrdt.MessageYjsSyncStep1 {
			serverStep1Payload, err := sub.session.BuildSyncStep1Payload()
			if err != nil {
				h.logger.Warn("project ws server sync-step1 build failed",
					"project_id", projectID,
					"document_id", documentID,
					"connection_id", conn.ID(),
					"error", err,
				)
				h.sendDocError(conn, documentID, "SYNC_ERROR", "document sync failed")
				return
			}
			if err := conn.Send(frameEnvelope(collabEnvelopeSyncStep1, framedDocUUID, serverStep1Payload)); err != nil {
				return
			}
		}

		// Broadcast updates to other subscribers
		if len(updatePayload) > 0 {
			updateFrame, err := buildUpdateFrame(framedDocUUID, updatePayload)
			if err != nil {
				h.logger.Warn("project ws update frame build failed",
					"project_id", projectID,
					"document_id", documentID,
					"connection_id", conn.ID(),
					"error", err,
				)
				h.sendDocError(conn, documentID, "SYNC_ERROR", "failed to build update frame")
				return
			}
			// Exclude this connection's multiplexed adapter from receiving its own broadcast
			h.documentBroadcaster.Broadcast(documentID, updateFrame, sub.conn)
		}

	case collabEnvelopeAwareness:
		// Broadcast awareness to all subscribers except sender
		h.documentBroadcaster.Broadcast(documentID, frameEnvelope(collabEnvelopeAwareness, framedDocUUID, payload), sub.conn)

	default:
		// Ignore unknown envelope types for forward compatibility.
	}
}

// handleProjectProposalCommand routes proposal commands through the existing proposal handlers
// after validating the document belongs to an active subscription.
func (h *CollabHandler) handleProjectProposalCommand(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	userUUID uuid.UUID,
	raw []byte,
	registry *projectSubscriptionRegistry,
	msgType string,
) {
	// Extract documentId from the raw message to validate subscription
	var docIDMsg struct {
		DocumentID string `json:"documentId"`
	}
	if err := json.Unmarshal(raw, &docIDMsg); err != nil {
		h.sendError(conn, "INTERNAL_ERROR", "invalid proposal command payload")
		return
	}

	documentID := strings.TrimSpace(docIDMsg.DocumentID)
	if parsed, err := parseUUID(documentID); err == nil {
		documentID = parsed.String()
	}
	sub, ok := registry.get(documentID)
	if !ok {
		h.sendDocError(conn, documentID, "NOT_SUBSCRIBED", "document is not subscribed on this connection")
		return
	}
	if reason, invalid := h.authenticator.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
		h.teardownSubscription(ctx, documentID, registry)
		h.sendDocUnsubscribed(conn, documentID, &reason)
		return
	}

	// Delegate to existing proposal handlers using the subscription's document context
	switch msgType {
	case wsTypeProposalAccept:
		h.handleProposalAccept(ctx, conn, sub.docID, sub.docUUID, userUUID, raw)
	case wsTypeProposalReject:
		h.handleProposalReject(ctx, conn, sub.docID, sub.docUUID, userUUID, raw)
	case wsTypeProposalGroupAccept:
		h.handleProposalGroupAccept(ctx, conn, sub.docID, sub.docUUID, userUUID, raw)
	}
}

// --- helpers ---

// sendDocError sends a document-scoped error that does NOT close the websocket.
func (h *CollabHandler) sendDocError(conn *websocketDocumentConnection, documentID string, code string, message string) {
	err := conn.SendJSON(docErrorEvent{
		Type:       wsTypeDocError,
		DocumentID: documentID,
		Code:       code,
		Message:    message,
	})
	if err != nil && !errors.Is(err, io.EOF) {
		h.logger.Debug("project ws failed to send doc:error",
			"document_id", documentID,
			"code", code,
			"error", err,
		)
	}
}

func (h *CollabHandler) sendDocUnsubscribed(conn *websocketDocumentConnection, documentID string, reason *string) {
	err := conn.SendJSON(docUnsubscribedEvent{
		Type:       wsTypeDocUnsubscribed,
		DocumentID: documentID,
		Reason:     reason,
	})
	if err != nil && !errors.Is(err, io.EOF) {
		h.logger.Debug("project ws failed to send doc:unsubscribed",
			"document_id", documentID,
			"error", err,
		)
	}
}
