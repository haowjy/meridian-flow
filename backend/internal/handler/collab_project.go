package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"golang.org/x/net/websocket"
	"meridian/internal/httputil"
	serviceCollab "meridian/internal/service/collab"
)

const (
	// projectMaxDocSubscriptions is the max concurrent document subscriptions per project WS.
	projectMaxDocSubscriptions = 10
)

// projectDocSubscription tracks a single document subscription within a project websocket.
type projectDocSubscription struct {
	docID   string // canonical UUID string
	docUUID uuid.UUID
	session *serviceCollab.DocumentSession
	conn    *multiplexedConnection // adapter registered with broadcaster
}

// projectSubscriptionRegistry is connection-local state for document subscriptions.
type projectSubscriptionRegistry struct {
	mu    sync.Mutex
	subs  map[string]*projectDocSubscription // keyed by canonical document UUID string
	limit int
}

func newProjectSubscriptionRegistry(limit int) *projectSubscriptionRegistry {
	return &projectSubscriptionRegistry{
		subs:  make(map[string]*projectDocSubscription),
		limit: limit,
	}
}

func (r *projectSubscriptionRegistry) get(docID string) (*projectDocSubscription, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sub, ok := r.subs[docID]
	return sub, ok
}

func (r *projectSubscriptionRegistry) add(sub *projectDocSubscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.subs) >= r.limit {
		return fmt.Errorf("subscription limit exceeded (%d)", r.limit)
	}
	r.subs[sub.docID] = sub
	return nil
}

func (r *projectSubscriptionRegistry) remove(docID string) (*projectDocSubscription, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sub, ok := r.subs[docID]
	if ok {
		delete(r.subs, docID)
	}
	return sub, ok
}

// all returns a snapshot of all subscriptions (safe for iteration during cleanup).
func (r *projectSubscriptionRegistry) all() []*projectDocSubscription {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*projectDocSubscription, 0, len(r.subs))
	for _, sub := range r.subs {
		out = append(out, sub)
	}
	return out
}

// --- JSON protocol message types for project websocket ---

const (
	wsTypeDocSubscribe    = "doc:subscribe"
	wsTypeDocUnsubscribe  = "doc:unsubscribe"
	wsTypeDocSubscribed   = "doc:subscribed"
	wsTypeDocUnsubscribed = "doc:unsubscribed"
	wsTypeDocError        = "doc:error"
)

type docSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docUnsubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docSubscribedEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docUnsubscribedEvent struct {
	Type       string  `json:"type"`
	DocumentID string  `json:"documentId"`
	Reason     *string `json:"reason,omitempty"`
}

type docErrorEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

// --- multiplexedConnection adapter ---

// multiplexedConnection wraps a project-level websocket connection to satisfy
// collabSvc.Connection for a single document subscription. Outbound binary frames
// are multiplexed with the document UUID prefix so the client can demux.
type multiplexedConnection struct {
	id     string
	parent *websocketDocumentConnection // shared project WS connection
}

func newMultiplexedConnection(parent *websocketDocumentConnection) *multiplexedConnection {
	return &multiplexedConnection{
		id:     uuid.NewString(),
		parent: parent,
	}
}

func (c *multiplexedConnection) ID() string {
	return c.id
}

// Send writes data through the parent project WS as-is.
// Broadcaster payloads are already multiplexed as [type][docUUID][payload].
func (c *multiplexedConnection) Send(data []byte) error {
	return c.parent.Send(data)
}

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
	_ = conn.SetReadDeadline(time.Now().Add(collabAuthMessageTimeout))

	// Auth bootstrap — same contract as document WS
	token, err := h.readFirstJWTMessage(conn)
	if err != nil {
		h.logger.Debug("project websocket missing/invalid first auth message",
			"project_id", projectID,
			"error", err,
		)
		h.sendError(wsConn, "AUTH_FAILED", "missing or invalid authentication token")
		return
	}

	claims, err := h.jwtVerifier.VerifyToken(token)
	if err != nil {
		h.logger.Debug("project websocket token verification failed",
			"project_id", projectID,
			"error", err,
		)
		h.sendError(wsConn, "AUTH_FAILED", "invalid or expired token")
		return
	}

	userID := claims.GetUserID()
	userUUID, err := parseUUID(userID)
	if err != nil {
		h.logger.Error("project websocket user id is not a uuid",
			"project_id", projectID,
			"user_id", userID,
			"error", err,
		)
		h.sendError(wsConn, "AUTH_FAILED", "invalid user identity")
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	h.logger.Info("project websocket authenticated",
		"project_id", projectID,
		"user_id", userID,
		"connection_id", wsConn.ID(),
	)

	registry := newProjectSubscriptionRegistry(projectMaxDocSubscriptions)
	defer h.cleanupProjectSubscriptions(ctx, registry, projectID, wsConn.ID())

	heartbeatAcks := make(chan struct{}, 1)
	heartbeatStop := make(chan struct{})
	go h.runHeartbeatLoop(wsConn, heartbeatAcks, heartbeatStop)
	defer close(heartbeatStop)

	inboundRateTracker := collabInboundRateTracker{}

	for {
		var rawMessage []byte
		if err := websocket.Message.Receive(conn, &rawMessage); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			h.logger.Debug("project websocket receive failed",
				"project_id", projectID,
				"connection_id", wsConn.ID(),
				"error", err,
			)
			return
		}

		allowed, limitExceeded := inboundRateTracker.allowInbound(time.Now())
		if !allowed {
			if limitExceeded {
				h.sendError(wsConn, "RATE_LIMITED", "too many inbound messages; muted for 1 second")
				h.logger.Warn("project websocket inbound rate limited",
					"project_id", projectID,
					"connection_id", wsConn.ID(),
					"rate_limit_per_sec", collabInboundRateLimit,
					"mute_seconds", collabInboundMutePeriod.Seconds(),
				)
			}
			continue
		}

		if len(rawMessage) == 0 {
			continue
		}

		// Try JSON message handling first
		if handled := h.handleProjectTextMessage(
			ctx, wsConn, projectID, userID, userUUID, rawMessage, heartbeatAcks, registry,
		); handled {
			continue
		}

		// Binary envelope handling — route by framed documentId
		h.handleProjectBinaryMessage(ctx, wsConn, projectID, userID, rawMessage, registry)
	}
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
	if len(raw) == 0 || raw[0] != '{' {
		return false
	}

	var typed collabTypedMessage
	if err := json.Unmarshal(raw, &typed); err != nil {
		return false
	}

	switch typed.Type {
	case wsTypeHeartbeat:
		nonBlockingSignal(heartbeatAcks)
		return true

	case wsTypeDocSubscribe:
		h.handleDocSubscribe(ctx, conn, projectID, userID, raw, registry)
		return true

	case wsTypeDocUnsubscribe:
		h.handleDocUnsubscribe(ctx, conn, raw, registry)
		return true

	case wsTypeProposalAccept:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, registry, typed.Type)
		return true

	case wsTypeProposalReject:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, registry, typed.Type)
		return true

	case wsTypeProposalGroupAccept:
		h.handleProjectProposalCommand(ctx, conn, projectID, userID, userUUID, raw, registry, typed.Type)
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
		_ = conn.SendJSON(docSubscribedEvent{
			Type:       wsTypeDocSubscribed,
			DocumentID: canonicalDocumentID,
		})
		return
	}

	// Verify access
	allowed, err := h.documentResolver.VerifyOwnership(ctx, canonicalDocumentID, userID)
	if err != nil {
		h.logger.Error("project ws ownership check failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"user_id", userID,
			"error", err,
		)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to verify document access")
		return
	}
	if !allowed {
		h.sendDocError(conn, canonicalDocumentID, "FORBIDDEN", "access denied")
		return
	}

	// Verify document belongs to this project
	docRef, err := h.documentResolver.ResolveDocument(ctx, canonicalDocumentID)
	if err != nil {
		h.logger.Error("project ws document resolve failed",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"error", err,
		)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to resolve document")
		return
	}
	resolvedProjectUUID, err := parseUUID(strings.TrimSpace(docRef.ProjectID))
	if err != nil {
		h.logger.Error("project ws resolve returned invalid project id",
			"project_id", projectID,
			"document_id", canonicalDocumentID,
			"resolved_project_id", docRef.ProjectID,
			"error", err,
		)
		h.sendDocError(conn, canonicalDocumentID, "INTERNAL_ERROR", "failed to resolve document")
		return
	}
	if resolvedProjectUUID.String() != projectID {
		h.sendDocError(conn, canonicalDocumentID, "PROJECT_MISMATCH", "document does not belong to this project")
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
		_ = h.sessionManager.Release(releaseCtx, canonicalDocumentID)
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
	_ = conn.SendJSON(docSubscribedEvent{
		Type:       wsTypeDocSubscribed,
		DocumentID: canonicalDocumentID,
	})
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
	if reason, invalid := h.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
		// Re-validate on active traffic so stale access/project scope is cleaned up quickly.
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
	if reason, invalid := h.getSubscriptionInvalidationReason(ctx, projectID, userID, documentID); invalid {
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

// teardownSubscription cleans up a single document subscription: unsubscribe broadcaster,
// release session, remove from registry. Safe to call if not subscribed.
func (h *CollabHandler) teardownSubscription(
	ctx context.Context,
	documentID string,
	registry *projectSubscriptionRegistry,
) {
	sub, ok := registry.remove(documentID)
	if !ok {
		return
	}

	if sub.conn != nil {
		h.documentBroadcaster.Unsubscribe(documentID, sub.conn)
	}

	if sub.session != nil {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.sessionManager.Release(releaseCtx, documentID); err != nil {
			h.logger.Error("project ws session release failed",
				"document_id", documentID,
				"error", err,
			)
		}
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

func (h *CollabHandler) getSubscriptionInvalidationReason(
	ctx context.Context,
	projectID string,
	userID string,
	documentID string,
) (string, bool) {
	allowed, err := h.documentResolver.VerifyOwnership(ctx, documentID, userID)
	if err != nil {
		h.logger.Error("project ws ownership check failed during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"user_id", userID,
			"error", err,
		)
		return "", false
	}
	if !allowed {
		return "access_revoked", true
	}

	docRef, err := h.documentResolver.ResolveDocument(ctx, documentID)
	if err != nil {
		h.logger.Error("project ws resolve failed during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"error", err,
		)
		return "", false
	}

	resolvedProjectUUID, err := parseUUID(strings.TrimSpace(docRef.ProjectID))
	if err != nil {
		h.logger.Error("project ws resolve returned invalid project id during active subscription validation",
			"project_id", projectID,
			"document_id", documentID,
			"resolved_project_id", docRef.ProjectID,
			"error", err,
		)
		return "", false
	}
	if resolvedProjectUUID.String() != projectID {
		return "project_mismatch", true
	}

	return "", false
}

// cleanupProjectSubscriptions tears down all active subscriptions on connection close.
func (h *CollabHandler) cleanupProjectSubscriptions(
	ctx context.Context,
	registry *projectSubscriptionRegistry,
	projectID string,
	connectionID string,
) {
	for _, sub := range registry.all() {
		if sub.conn != nil {
			h.documentBroadcaster.Unsubscribe(sub.docID, sub.conn)
		}
		if sub.session != nil {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := h.sessionManager.Release(releaseCtx, sub.docID); err != nil {
				h.logger.Error("project ws cleanup session release failed",
					"project_id", projectID,
					"document_id", sub.docID,
					"connection_id", connectionID,
					"error", err,
				)
			}
			cancel()
		}
	}
}
