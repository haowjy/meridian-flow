package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"golang.org/x/net/websocket"
	"meridian/internal/auth"
	"meridian/internal/config"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/httputil"
	serviceCollab "meridian/internal/service/collab"
)

// documentSessionManager is a narrow interface for session lifecycle (ISP).
// Decouples the handler from the concrete DocumentSessionManager implementation.
type documentSessionManager interface {
	Acquire(ctx context.Context, docID string) (*serviceCollab.DocumentSession, error)
	Release(ctx context.Context, docID string) error
}

// CollabHandler handles collaboration transport entrypoints.
type CollabHandler struct {
	documentResolver    collabSvc.DocumentResolver
	documentBroadcaster collabSvc.DocumentBroadcaster
	sessionManager      documentSessionManager
	jwtVerifier         auth.JWTVerifier
	logger              *slog.Logger
	config              *config.Config
}

const (
	collabAuthMessageTimeout = 5 * time.Second
	collabMaxMessageBytes    = 64 * 1024
	collabHeartbeatInterval  = 30 * time.Second
	collabHeartbeatTimeout   = 5 * time.Second

	collabEnvelopeSyncStep1 byte = 0x00
	collabEnvelopeSyncStep2 byte = 0x01
	collabEnvelopeUpdate    byte = 0x02
	collabEnvelopeAwareness byte = 0x03
)

type collabErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type collabHeartbeatMessage struct {
	Type string `json:"type"`
}

// websocketDocumentConnection wraps a websocket with write serialization.
type websocketDocumentConnection struct {
	id      string
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func newWebsocketDocumentConnection(conn *websocket.Conn) *websocketDocumentConnection {
	return &websocketDocumentConnection{
		id:   uuid.NewString(),
		conn: conn,
	}
}

func (c *websocketDocumentConnection) ID() string {
	return c.id
}

func (c *websocketDocumentConnection) Send(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return websocket.Message.Send(c.conn, data)
}

func (c *websocketDocumentConnection) SendJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return websocket.JSON.Send(c.conn, v)
}

func (c *websocketDocumentConnection) Close() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.Close()
}

// NewCollabHandler creates a new collaboration handler.
func NewCollabHandler(
	documentResolver collabSvc.DocumentResolver,
	documentBroadcaster collabSvc.DocumentBroadcaster,
	sessionManager documentSessionManager,
	jwtVerifier auth.JWTVerifier,
	logger *slog.Logger,
	cfg *config.Config,
) *CollabHandler {
	return &CollabHandler{
		documentResolver:    documentResolver,
		documentBroadcaster: documentBroadcaster,
		sessionManager:      sessionManager,
		jwtVerifier:         jwtVerifier,
		logger:              logger,
		config:              cfg,
	}
}

// ConnectDocument upgrades and serves websocket collaboration transport.
// GET /ws/documents/{id}
func (h *CollabHandler) ConnectDocument(w http.ResponseWriter, r *http.Request) {
	docID, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return
	}

	if _, err := parseUUID(docID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Document identifier must be a valid UUID")
		return
	}

	wsServer := websocket.Server{
		// Phase-1 transport should accept non-browser clients during smoke checks.
		Handshake: func(_ *websocket.Config, _ *http.Request) error { return nil },
		Handler: func(conn *websocket.Conn) {
			h.handleDocumentSocket(r.Context(), docID, conn)
		},
	}
	wsServer.ServeHTTP(w, r)
}

func (h *CollabHandler) handleDocumentSocket(ctx context.Context, docID string, conn *websocket.Conn) {
	wsConn := newWebsocketDocumentConnection(conn)
	defer func() {
		_ = wsConn.Close()
	}()

	conn.MaxPayloadBytes = collabMaxMessageBytes
	_ = conn.SetReadDeadline(time.Now().Add(collabAuthMessageTimeout))

	token, err := h.readFirstJWTMessage(conn)
	if err != nil {
		h.logger.Debug("collab websocket missing/invalid first auth message",
			"document_id", docID,
			"error", err,
		)
		h.sendError(wsConn, "AUTH_FAILED", "missing or invalid authentication token")
		return
	}

	claims, err := h.jwtVerifier.VerifyToken(token)
	if err != nil {
		h.logger.Debug("collab websocket token verification failed",
			"document_id", docID,
			"error", err,
		)
		h.sendError(wsConn, "AUTH_FAILED", "invalid or expired token")
		return
	}

	userID := claims.GetUserID()
	allowed, err := h.documentResolver.VerifyOwnership(ctx, docID, userID)
	if err != nil {
		h.logger.Error("collab ownership check failed",
			"document_id", docID,
			"user_id", userID,
			"error", err,
		)
		h.sendError(wsConn, "INTERNAL_ERROR", "failed to verify document access")
		return
	}
	if !allowed {
		h.sendError(wsConn, "FORBIDDEN", "access denied")
		return
	}

	session, err := h.sessionManager.Acquire(ctx, docID)
	if err != nil {
		h.logger.Error("collab session acquire failed",
			"document_id", docID,
			"user_id", userID,
			"error", err,
		)
		h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
		return
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.sessionManager.Release(releaseCtx, docID); err != nil {
			h.logger.Error("collab session release failed",
				"document_id", docID,
				"error", err,
			)
		}
	}()

	if err := h.documentBroadcaster.Subscribe(docID, wsConn); err != nil {
		h.logger.Error("collab subscribe failed",
			"document_id", docID,
			"user_id", userID,
			"error", err,
		)
		h.sendError(wsConn, "INTERNAL_ERROR", "failed to register collab connection")
		return
	}
	defer h.documentBroadcaster.Unsubscribe(docID, wsConn)

	_ = conn.SetReadDeadline(time.Time{})
	h.logger.Info("collab websocket authenticated",
		"document_id", docID,
		"user_id", userID,
		"connection_id", wsConn.ID(),
	)

	heartbeatAcks := make(chan struct{}, 1)
	heartbeatStop := make(chan struct{})
	go h.runHeartbeatLoop(wsConn, heartbeatAcks, heartbeatStop)
	defer close(heartbeatStop)

	for {
		var rawMessage []byte
		if err := websocket.Message.Receive(conn, &rawMessage); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			h.logger.Debug("collab websocket receive failed",
				"document_id", docID,
				"connection_id", wsConn.ID(),
				"error", err,
			)
			return
		}

		if h.isHeartbeatMessage(rawMessage) {
			nonBlockingSignal(heartbeatAcks)
			continue
		}

		if len(rawMessage) == 0 {
			continue
		}

		envelopeType := rawMessage[0]
		payload := rawMessage[1:]

		switch envelopeType {
		case collabEnvelopeSyncStep1, collabEnvelopeSyncStep2, collabEnvelopeUpdate:
			syncType, responsePayload, updatePayload, err := session.HandleSyncPayload(ctx, payload, wsConn.ID())
			if err != nil {
				h.logger.Warn("collab sync message handling failed",
					"document_id", docID,
					"connection_id", wsConn.ID(),
					"error", err,
				)
				h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
				return
			}

			if !envelopeMatchesSyncType(envelopeType, syncType) {
				h.logger.Warn("collab envelope/sync type mismatch",
					"document_id", docID,
					"connection_id", wsConn.ID(),
					"envelope_type", envelopeType,
					"sync_type", syncType,
				)
				h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
				return
			}
			if envelopeType == collabEnvelopeSyncStep1 && len(responsePayload) == 0 {
				h.logger.Warn("collab sync-step1 produced empty response",
					"document_id", docID,
					"connection_id", wsConn.ID(),
				)
				h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
				return
			}

			if len(responsePayload) > 0 {
				responseEnvelope, err := envelopeTypeFromSyncPayload(responsePayload)
				if err != nil {
					h.logger.Warn("collab response envelope parse failed",
						"document_id", docID,
						"connection_id", wsConn.ID(),
						"error", err,
					)
					h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
					return
				}

				if err := wsConn.Send(frameEnvelope(responseEnvelope, responsePayload)); err != nil {
					return
				}
			}

			if envelopeType == collabEnvelopeSyncStep1 && syncType == ycrdt.MessageYjsSyncStep1 {
				serverStep1Payload, err := session.BuildSyncStep1Payload()
				if err != nil {
					h.logger.Warn("collab server sync-step1 build failed",
						"document_id", docID,
						"connection_id", wsConn.ID(),
						"error", err,
					)
					h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
					return
				}

				if err := wsConn.Send(frameEnvelope(collabEnvelopeSyncStep1, serverStep1Payload)); err != nil {
					return
				}
			}

			if len(updatePayload) > 0 {
				updateFrame, err := buildUpdateFrame(updatePayload)
				if err != nil {
					h.logger.Warn("collab update frame build failed",
						"document_id", docID,
						"connection_id", wsConn.ID(),
						"error", err,
					)
					h.sendError(wsConn, "RESET_REQUIRED", "document state requires reset")
					return
				}

				h.documentBroadcaster.Broadcast(docID, updateFrame, wsConn)
			}

		case collabEnvelopeAwareness:
			h.documentBroadcaster.Broadcast(docID, rawMessage, wsConn)

		default:
			// Ignore unknown envelope types for forward compatibility.
		}
	}
}

func (h *CollabHandler) runHeartbeatLoop(conn *websocketDocumentConnection, acks <-chan struct{}, stop <-chan struct{}) {
	ticker := time.NewTicker(collabHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			drainSignalChannel(acks)

			if err := conn.SendJSON(collabHeartbeatMessage{Type: "heartbeat"}); err != nil {
				return
			}

			timeout := time.NewTimer(collabHeartbeatTimeout)
			select {
			case <-stop:
				timeout.Stop()
				return
			case <-acks:
				timeout.Stop()
			case <-timeout.C:
				if err := conn.Close(); err != nil {
					h.logger.Debug("collab heartbeat timeout close failed", "error", err)
				}
				return
			}
		}
	}
}

func (h *CollabHandler) readFirstJWTMessage(conn *websocket.Conn) (string, error) {
	var token string
	if err := websocket.Message.Receive(conn, &token); err != nil {
		return "", err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", fmt.Errorf("auth message is empty")
	}
	return token, nil
}

func (h *CollabHandler) sendError(conn *websocketDocumentConnection, code string, message string) {
	err := conn.SendJSON(collabErrorMessage{
		Type:    "error",
		Code:    code,
		Message: message,
	})
	if err != nil && !errors.Is(err, io.EOF) {
		h.logger.Debug("collab websocket failed to send error message",
			"code", code,
			"error", err,
		)
	}
}

func (h *CollabHandler) isHeartbeatMessage(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}

	// Fast-path: binary Yjs frames never start with '{', so skip JSON decode
	// for the vast majority of messages (sync/update/awareness payloads).
	// Coupling: client sends heartbeat acks as JSON text frames (see buildHeartbeatAckMessage).
	// If that changes to a binary-envelope format, this guard must be updated.
	if raw[0] != '{' {
		return false
	}

	var msg collabHeartbeatMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}

	return msg.Type == "heartbeat"
}

