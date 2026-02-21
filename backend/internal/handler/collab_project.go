package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"golang.org/x/net/websocket"
	"meridian/internal/httputil"
	serviceCollab "meridian/internal/service/collab"
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
	connectionID := wsConn.ID()
	h.logger.Info("project websocket authenticated",
		"project_id", projectID,
		"user_id", userID,
		"connection_id", connectionID,
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

	// Subscription service handles per-connection cleanup on close.
	defer h.subscriptionService.UnsubscribeAll(ctx, connectionID)

	heartbeatAcks := make(chan struct{}, 1)
	heartbeatStop := make(chan struct{})
	go h.runHeartbeatLoop(wsConn, heartbeatAcks, heartbeatStop)
	defer close(heartbeatStop)

	// Run the shared message loop with project-specific handlers
	runMessageLoop(conn, wsConn, messageLoopHandlers{
		onTextMessage: func(raw []byte) bool {
			return h.handleProjectTextMessage(ctx, wsConn, projectID, userID, userUUID, raw, heartbeatAcks, connectionID)
		},
		onBinaryMessage: func(raw []byte) {
			h.handleProjectBinaryMessage(ctx, wsConn, projectID, userID, raw, connectionID)
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
	connectionID string,
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
		h.handleDocSubscribe(ctx, conn, projectID, userID, raw, connectionID)
		return true

	case wsTypeDocUnsubscribe:
		h.handleDocUnsubscribe(ctx, conn, raw, connectionID)
		return true

	case wsTypeProposalAccept, wsTypeProposalReject, wsTypeProposalGroupAccept, wsTypeProposalRequestUpdate:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, connectionID, msgType)
		return true

	default:
		// Ignore unknown JSON message types for forward compatibility.
		return true
	}
}

// handleDocSubscribe processes a doc:subscribe command.
//
// Handler responsibilities (transport boundary):
//  1. Parse JSON payload + validate fields
//  2. Check document access via authenticator
//  3. Delegate to subscriptionService.Subscribe
//  4. Send sync state + ack over WS
//  5. Map service errors to WS error codes
func (h *CollabHandler) handleDocSubscribe(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	raw []byte,
	connectionID string,
) {
	// --- 1. Parse + validate ---
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

	// --- 2. Check document access ---
	if errCode, errMsg := h.authenticator.checkDocumentAccess(ctx, projectID, userID, canonicalDocumentID); errCode != "" {
		h.sendDocError(conn, canonicalDocumentID, errCode, errMsg)
		return
	}

	// --- 3. Delegate to subscription service ---
	muxConn := newMultiplexedConnection(conn)
	result, err := h.subscriptionService.Subscribe(ctx, serviceCollab.SubscribeRequest{
		ConnectionID: connectionID,
		DocumentID:   canonicalDocumentID,
		DocumentUUID: docUUID,
		Conn:         muxConn,
	})
	if err != nil {
		if errors.Is(err, serviceCollab.ErrSubscriptionLimitExceeded) {
			h.sendDocError(conn, canonicalDocumentID, "SUBSCRIPTION_LIMIT",
				fmt.Sprintf("max %d concurrent subscriptions", h.subscriptionService.MaxPerConnection()))
			return
		}
		h.logger.Error("project ws subscribe failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to initialize document session")
		return
	}

	// Idempotent: if already subscribed, just re-ack
	if result.AlreadySubscribed {
		err := conn.SendJSON(docSubscribedEvent{
			Type:       wsTypeDocSubscribed,
			DocumentID: canonicalDocumentID,
		})
		if err != nil && !errors.Is(err, io.EOF) {
			h.logger.Debug("project ws failed to send doc:subscribed (idempotent)",
				"project_id", projectID,
				"document_id", canonicalDocumentID,
				"error", err,
			)
		}
		return
	}

	// --- 4. Send sync state + ack ---

	// 4a. sync-step1 binary frame (multiplexed)
	serverStep1Payload, err := result.Subscription.Session.BuildSyncStep1Payload()
	if err != nil {
		h.logger.Error("project ws sync-step1 build failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.subscriptionService.Unsubscribe(ctx, connectionID, canonicalDocumentID)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to build sync state")
		return
	}
	if err := conn.Send(frameEnvelope(collabEnvelopeSyncStep1, docUUID, serverStep1Payload)); err != nil {
		h.subscriptionService.Unsubscribe(ctx, connectionID, canonicalDocumentID)
		return
	}

	// 4b. proposal:snapshot JSON
	if err := h.sendProposalSnapshot(ctx, conn, docUUID); err != nil {
		h.logger.Error("project ws proposal snapshot failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.subscriptionService.Unsubscribe(ctx, connectionID, canonicalDocumentID)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to load proposal snapshot")
		return
	}

	// 4c. doc:subscribed (terminal ack)
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
	connectionID string,
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

	// Delegate teardown to subscription service (safe if not subscribed)
	h.subscriptionService.Unsubscribe(ctx, connectionID, canonicalDocumentID)
	h.sendDocUnsubscribed(conn, canonicalDocumentID, nil)
}

// handleProjectBinaryMessage routes multiplexed binary frames to the correct document subscription.
func (h *CollabHandler) handleProjectBinaryMessage(
	ctx context.Context,
	conn *websocketDocumentConnection,
	projectID string,
	userID string,
	rawMessage []byte,
	connectionID string,
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
	sub, ok := h.subscriptionService.GetSubscription(connectionID, documentID)
	if !ok {
		h.sendDocError(conn, documentID, "NOT_SUBSCRIBED", "document is not subscribed on this connection")
		return
	}
	// Re-validate on active traffic so stale access/project scope is cleaned up quickly.
	if reason, invalid := h.authenticator.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
		h.subscriptionService.Unsubscribe(ctx, connectionID, documentID)
		h.sendDocUnsubscribed(conn, documentID, &reason)
		return
	}

	switch envelopeType {
	case collabEnvelopeSyncStep1, collabEnvelopeSyncStep2, collabEnvelopeUpdate:
		syncType, responsePayload, updatePayload, err := sub.Session.HandleSyncPayload(ctx, payload, conn.ID())
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
			serverStep1Payload, err := sub.Session.BuildSyncStep1Payload()
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
			h.documentBroadcaster.Broadcast(documentID, updateFrame, sub.Conn)
		}

	case collabEnvelopeAwareness:
		// Broadcast awareness to all subscribers except sender
		h.documentBroadcaster.Broadcast(documentID, frameEnvelope(collabEnvelopeAwareness, framedDocUUID, payload), sub.Conn)

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
	connectionID string,
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
	sub, ok := h.subscriptionService.GetSubscription(connectionID, documentID)
	if !ok {
		h.sendDocError(conn, documentID, "NOT_SUBSCRIBED", "document is not subscribed on this connection")
		return
	}
	if reason, invalid := h.authenticator.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
		h.subscriptionService.Unsubscribe(ctx, connectionID, documentID)
		h.sendDocUnsubscribed(conn, documentID, &reason)
		return
	}

	// Delegate to existing proposal handlers using the subscription's document context
	switch msgType {
	case wsTypeProposalAccept:
		h.handleProposalAccept(ctx, conn, sub.DocID, sub.DocUUID, userUUID, raw)
	case wsTypeProposalReject:
		h.handleProposalReject(ctx, conn, sub.DocID, sub.DocUUID, userUUID, raw)
	case wsTypeProposalGroupAccept:
		h.handleProposalGroupAccept(ctx, conn, sub.DocID, sub.DocUUID, userUUID, raw)
	case wsTypeProposalRequestUpdate:
		h.handleProposalRequestUpdate(ctx, conn, sub.DocID, sub.DocUUID, raw)
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
