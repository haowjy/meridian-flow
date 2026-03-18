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

	"github.com/coder/websocket"
	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	"golang.org/x/time/rate"
	"meridian/internal/auth"
	"meridian/internal/config"
	"meridian/internal/domain"
	collabSvc "meridian/internal/domain/services/collab"
	serviceCollab "meridian/internal/service/collab"
)

// CollabDocumentHandler serves per-document websocket connections.
type CollabDocumentHandler struct {
	sessionManager *serviceCollab.DocumentSessionManager
	authenticator  *collabAuthenticator
	logger         *slog.Logger
	config         *config.Config

	// Per-user connection tracking
	connMu     sync.Mutex
	connCounts map[string]int // userID -> active connection count

	// Per-document websocket fanout for sync updates.
	documentConnMu sync.RWMutex
	documentConns  map[string]map[*websocket.Conn]struct{}
}

const (
	docWSMaxConnPerUser    = 10
	docWSReadLimit         = 2 * 1024 * 1024 // 2MB library-level safety net
	docWSAppMaxFrame       = 256 * 1024      // 256KB application-level max
	docWSIdleTimeout       = 5 * time.Minute
	docWSHeartbeatInterval = 30 * time.Second
	docWSHeartbeatTimeout  = 5 * time.Second
	docWSAuthTimeout       = 5 * time.Second
	docWSReleaseTimeout    = 10 * time.Second

	docWSPrefixSync      byte = 0x00
	docWSPrefixAwareness byte = 0x01
)

// NewCollabDocumentHandler creates a per-document collaboration websocket handler.
func NewCollabDocumentHandler(
	sessionManager *serviceCollab.DocumentSessionManager,
	jwtVerifier auth.JWTVerifier,
	documentResolver collabSvc.DocumentResolver,
	logger *slog.Logger,
	cfg *config.Config,
) *CollabDocumentHandler {
	var isIdentityBlocked func(string, string) bool
	if cfg != nil {
		isIdentityBlocked = cfg.IsProdIdentityBlocked
	}

	return &CollabDocumentHandler{
		sessionManager: sessionManager,
		authenticator:  newCollabAuthenticator(jwtVerifier, documentResolver, isIdentityBlocked, logger),
		logger:         logger,
		config:         cfg,
		connCounts:     make(map[string]int),
		documentConns:  make(map[string]map[*websocket.Conn]struct{}),
	}
}

// ConnectDocument upgrades and serves a document-scoped websocket connection.
// GET /ws/documents/{documentId}
func (h *CollabDocumentHandler) ConnectDocument(w http.ResponseWriter, r *http.Request) {
	documentID := strings.TrimSpace(r.PathValue("documentId"))
	if documentID == "" {
		http.Error(w, "Document identifier is required", http.StatusBadRequest)
		return
	}

	documentUUID, err := parseUUID(documentID)
	if err != nil {
		http.Error(w, "Document identifier must be a valid UUID", http.StatusBadRequest)
		return
	}
	canonicalDocumentID := documentUUID.String()

	originPatterns := []string{}
	if h.config != nil && h.config.CORSOrigins != "" {
		for _, pattern := range strings.Split(h.config.CORSOrigins, ",") {
			trimmed := strings.TrimSpace(pattern)
			if trimmed != "" {
				originPatterns = append(originPatterns, trimmed)
			}
		}
	}

	opts := &websocket.AcceptOptions{
		InsecureSkipVerify: h.config != nil && h.config.Environment == "dev",
		OriginPatterns:     originPatterns,
		CompressionMode:    websocket.CompressionDisabled,
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		h.logger.Debug("document ws accept failed",
			"document_id", canonicalDocumentID,
			"error", err,
		)
		return
	}

	conn.SetReadLimit(docWSReadLimit)
	h.handleDocumentSocket(r.Context(), conn, canonicalDocumentID)
}

func (h *CollabDocumentHandler) handleDocumentSocket(parentCtx context.Context, conn *websocket.Conn, documentID string) {
	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	var (
		userID          string
		session         *serviceCollab.DocumentSession
		ownsConnSlot    bool
		isDocConnActive bool
	)

	defer func() {
		if isDocConnActive {
			h.unregisterDocumentConnection(documentID, conn)
		}

		if session != nil {
			releaseCtx, releaseCancel := context.WithTimeout(context.Background(), docWSReleaseTimeout)
			if err := h.sessionManager.Release(releaseCtx, documentID); err != nil {
				h.logger.Error("document ws session release failed",
					"document_id", documentID,
					"user_id", userID,
					"error", err,
				)
			}
			releaseCancel()
		}

		if ownsConnSlot {
			h.decrementConnectionCount(userID)
		}

		_ = conn.Close(websocket.StatusNormalClosure, "connection closed")
	}()

	// ---- auth phase (first message must be JWT text token) ----
	authCtx, authCancel := context.WithTimeout(ctx, docWSAuthTimeout)
	msgType, msg, err := conn.Read(authCtx)
	authCancel()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(authCtx.Err(), context.DeadlineExceeded) {
			h.sendErrorAndCloseDetached(conn, "AUTH_TIMEOUT", "authentication message timeout")
			return
		}
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", domain.ErrAuthFailed.Error())
		return
	}

	if msgType != websocket.MessageText {
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", "expected text JWT as first message")
		return
	}

	token := strings.TrimSpace(string(msg))
	if token == "" {
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", domain.ErrAuthFailed.Error())
		return
	}

	claims, err := h.authenticator.jwtVerifier.VerifyToken(token)
	if err != nil {
		h.sendErrorAndCloseDetached(conn, "AUTH_EXPIRED", domain.ErrAuthExpired.Error())
		return
	}

	userID = strings.TrimSpace(claims.GetUserID())
	if userID == "" {
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", domain.ErrAuthFailed.Error())
		return
	}
	if h.authenticator.isIdentityBlocked != nil && h.authenticator.isIdentityBlocked(userID, claims.Email) {
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", domain.ErrAuthFailed.Error())
		return
	}
	if _, err := parseUUID(userID); err != nil {
		h.sendErrorAndCloseDetached(conn, "AUTH_FAILED", "authenticated user id must be a UUID")
		return
	}

	allowed, err := h.authenticator.documentResolver.VerifyOwnership(ctx, documentID, userID)
	if err != nil {
		h.logger.Error("document ws ownership check failed",
			"document_id", documentID,
			"user_id", userID,
			"error", err,
		)
		h.sendErrorAndCloseDetached(conn, "INTERNAL_ERROR", "failed to verify document access")
		return
	}
	if !allowed {
		h.sendErrorAndCloseDetached(conn, "FORBIDDEN", "access denied")
		return
	}

	jwtExpiry := time.Time{}
	if claims.ExpiresAt != nil {
		jwtExpiry = claims.ExpiresAt.Time
	}

	if !h.tryIncrementConnectionCount(userID) {
		h.sendErrorAndCloseDetached(
			conn,
			"CONNECTION_LIMIT",
			fmt.Sprintf("%s: max %d active websocket connections", domain.ErrConnectionLimit.Error(), docWSMaxConnPerUser),
		)
		return
	}
	ownsConnSlot = true

	session, err = h.sessionManager.Acquire(ctx, documentID)
	if err != nil {
		h.logger.Error("document ws session acquire failed",
			"document_id", documentID,
			"user_id", userID,
			"error", err,
		)
		h.sendErrorAndCloseDetached(conn, "INTERNAL_ERROR", "failed to acquire document session")
		return
	}

	h.registerDocumentConnection(documentID, conn)
	isDocConnActive = true

	if err := h.sendJSON(ctx, conn, struct {
		Type      string `json:"type"`
		StateSize int    `json:"stateSize"`
		Protocol  int    `json:"protocol"`
	}{
		Type:      "connected",
		StateSize: 0, // TODO(ws-stage-3): populate with encoded state size for bootstrap lane heuristics.
		Protocol:  1,
	}); err != nil {
		return
	}

	syncStep1Payload, err := session.BuildSyncStep1Payload()
	if err != nil {
		h.logger.Error("document ws failed to build server sync-step1",
			"document_id", documentID,
			"user_id", userID,
			"error", err,
		)
		h.sendErrorAndCloseDetached(conn, "INTERNAL_ERROR", "failed to build initial sync payload")
		return
	}
	if err := h.sendBinary(ctx, conn, addDocPrefix(docWSPrefixSync, syncStep1Payload)); err != nil {
		return
	}

	heartbeatAcks := make(chan struct{}, 1)
	appActivitySignals := make(chan struct{}, 1)

	go h.runDocumentHeartbeatLoop(ctx, cancel, conn, heartbeatAcks, jwtExpiry, documentID, userID)
	go h.runDocumentIdleLoop(ctx, cancel, conn, appActivitySignals, documentID, userID)

	inboundLimiter := rate.NewLimiter(rate.Limit(collabInboundRateLimit), collabInboundRateLimit)

	for {
		inboundType, raw, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
				return
			}

			statusCode := websocket.CloseStatus(err)
			if statusCode == websocket.StatusNormalClosure || statusCode == websocket.StatusGoingAway {
				return
			}

			h.logger.Debug("document ws receive failed",
				"document_id", documentID,
				"user_id", userID,
				"error", err,
			)
			return
		}

		if !inboundLimiter.Allow() {
			_ = h.sendJSON(ctx, conn, collabErrorMessage{
				Type:    "error",
				Code:    "RATE_LIMITED",
				Message: "too many inbound messages",
			})
			continue
		}
		if len(raw) == 0 {
			continue
		}

		switch inboundType {
		case websocket.MessageText:
			typedMsg, ok := tryParseTypedMessage(raw)
			if !ok {
				h.logger.Debug("document ws ignoring non-protocol text message",
					"document_id", documentID,
					"user_id", userID,
				)
				continue
			}

			if typedMsg == wsTypeHeartbeat {
				nonBlockingSignal(heartbeatAcks)
				continue
			}

			h.logger.Debug("document ws ignoring unknown text type",
				"document_id", documentID,
				"user_id", userID,
				"type", typedMsg,
			)

		case websocket.MessageBinary:
			if len(raw) > docWSAppMaxFrame {
				h.sendErrorAndCloseDetached(
					conn,
					"FRAME_TOO_LARGE",
					fmt.Sprintf("%s: max %d bytes", domain.ErrFrameTooLarge.Error(), docWSAppMaxFrame),
				)
				return
			}
			if len(raw) < 1 {
				h.sendErrorAndCloseDetached(conn, "RESET_REQUIRED", "invalid binary frame")
				return
			}

			prefix := raw[0]
			payload := raw[1:]

			switch prefix {
			case docWSPrefixSync:
				nonBlockingSignal(appActivitySignals)

				_, responsePayload, updatePayload, err := session.HandleSyncPayload(ctx, payload, "human")
				if err != nil {
					h.logger.Warn("document ws sync handling failed",
						"document_id", documentID,
						"user_id", userID,
						"error", err,
					)
					h.sendErrorAndCloseDetached(conn, "RESET_REQUIRED", "document sync failed; please reconnect")
					return
				}

				if len(responsePayload) > 0 {
					if err := h.sendBinary(ctx, conn, addDocPrefix(docWSPrefixSync, responsePayload)); err != nil {
						return
					}
				}

				if len(updatePayload) > 0 {
					encodedUpdate, err := encodeSyncUpdatePayload(updatePayload)
					if err != nil {
						h.logger.Warn("document ws failed to encode update payload",
							"document_id", documentID,
							"user_id", userID,
							"error", err,
						)
						h.sendErrorAndCloseDetached(conn, "RESET_REQUIRED", "document sync failed; please reconnect")
						return
					}

					h.broadcastDocumentBinary(ctx, documentID, conn, addDocPrefix(docWSPrefixSync, encodedUpdate))
				}

			case docWSPrefixAwareness:
				nonBlockingSignal(appActivitySignals)
				// Phase 5: awareness fanout when multi-user cursors/presence is enabled.
				h.logger.Debug("document ws awareness frame received",
					"document_id", documentID,
					"user_id", userID,
				)

			default:
				h.logger.Debug("document ws unknown frame prefix",
					"document_id", documentID,
					"user_id", userID,
					"prefix", prefix,
				)
			}
		}
	}
}

func (h *CollabDocumentHandler) runDocumentHeartbeatLoop(
	ctx context.Context,
	cancel context.CancelFunc,
	conn *websocket.Conn,
	heartbeatAcks <-chan struct{},
	jwtExpiry time.Time,
	documentID string,
	userID string,
) {
	ticker := time.NewTicker(docWSHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !jwtExpiry.IsZero() && time.Now().After(jwtExpiry) {
				h.sendErrorAndCloseDetached(conn, "AUTH_EXPIRED", domain.ErrAuthExpired.Error())
				cancel()
				return
			}

			drainSignalChannel(heartbeatAcks)

			sendCtx, sendCancel := context.WithTimeout(ctx, docWSHeartbeatTimeout)
			err := h.sendJSON(sendCtx, conn, collabHeartbeatMessage{Type: wsTypeHeartbeat})
			sendCancel()
			if err != nil {
				h.logger.Debug("document ws heartbeat send failed",
					"document_id", documentID,
					"user_id", userID,
					"error", err,
				)
				cancel()
				return
			}

			timeout := time.NewTimer(docWSHeartbeatTimeout)
			select {
			case <-ctx.Done():
				timeout.Stop()
				return
			case <-heartbeatAcks:
				timeout.Stop()
			case <-timeout.C:
				h.logger.Warn("document ws heartbeat timeout",
					"document_id", documentID,
					"user_id", userID,
				)
				_ = conn.Close(websocket.StatusPolicyViolation, "heartbeat timeout")
				cancel()
				return
			}
		}
	}
}

func (h *CollabDocumentHandler) runDocumentIdleLoop(
	ctx context.Context,
	cancel context.CancelFunc,
	conn *websocket.Conn,
	activity <-chan struct{},
	documentID string,
	userID string,
) {
	idleTimer := time.NewTimer(docWSIdleTimeout)
	defer idleTimer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-activity:
			if !idleTimer.Stop() {
				select {
				case <-idleTimer.C:
				default:
				}
			}
			idleTimer.Reset(docWSIdleTimeout)
		case <-idleTimer.C:
			h.logger.Info("document ws idle timeout",
				"document_id", documentID,
				"user_id", userID,
				"idle_timeout_seconds", int(docWSIdleTimeout.Seconds()),
			)
			_ = conn.Close(websocket.StatusPolicyViolation, "idle timeout")
			cancel()
			return
		}
	}
}

func (h *CollabDocumentHandler) tryIncrementConnectionCount(userID string) bool {
	h.connMu.Lock()
	defer h.connMu.Unlock()

	current := h.connCounts[userID]
	if current >= docWSMaxConnPerUser {
		return false
	}
	h.connCounts[userID] = current + 1
	return true
}

func (h *CollabDocumentHandler) decrementConnectionCount(userID string) {
	if userID == "" {
		return
	}

	h.connMu.Lock()
	defer h.connMu.Unlock()

	current := h.connCounts[userID]
	if current <= 1 {
		delete(h.connCounts, userID)
		return
	}
	h.connCounts[userID] = current - 1
}

func (h *CollabDocumentHandler) registerDocumentConnection(documentID string, conn *websocket.Conn) {
	h.documentConnMu.Lock()
	defer h.documentConnMu.Unlock()

	connections, ok := h.documentConns[documentID]
	if !ok {
		connections = make(map[*websocket.Conn]struct{})
		h.documentConns[documentID] = connections
	}
	connections[conn] = struct{}{}
}

func (h *CollabDocumentHandler) unregisterDocumentConnection(documentID string, conn *websocket.Conn) {
	h.documentConnMu.Lock()
	defer h.documentConnMu.Unlock()

	connections, ok := h.documentConns[documentID]
	if !ok {
		return
	}
	delete(connections, conn)
	if len(connections) == 0 {
		delete(h.documentConns, documentID)
	}
}

func (h *CollabDocumentHandler) broadcastDocumentBinary(
	ctx context.Context,
	documentID string,
	sender *websocket.Conn,
	data []byte,
) {
	h.documentConnMu.RLock()
	connections := h.documentConns[documentID]
	targets := make([]*websocket.Conn, 0, len(connections))
	for conn := range connections {
		if conn == sender {
			continue
		}
		targets = append(targets, conn)
	}
	h.documentConnMu.RUnlock()

	for _, target := range targets {
		writeCtx, writeCancel := context.WithTimeout(ctx, docWSHeartbeatTimeout)
		err := h.sendBinary(writeCtx, target, data)
		writeCancel()
		if err != nil {
			h.logger.Debug("document ws broadcast send failed",
				"document_id", documentID,
				"error", err,
			)
		}
	}
}

// BroadcastToDocument sends binary data to all connected document WS clients.
// Used by proposal acceptance to fan out Yjs updates from server-initiated actions.
func (h *CollabDocumentHandler) BroadcastToDocument(documentID string, data []byte) {
	h.broadcastDocumentBinary(context.Background(), documentID, nil, data)
}

// HasOwnerTabs reports whether the document currently has any connected owner tabs.
func (h *CollabDocumentHandler) HasOwnerTabs(documentID uuid.UUID) bool {
	h.documentConnMu.RLock()
	defer h.documentConnMu.RUnlock()

	return len(h.documentConns[documentID.String()]) > 0
}

func (h *CollabDocumentHandler) sendBinary(ctx context.Context, conn *websocket.Conn, data []byte) error {
	return conn.Write(ctx, websocket.MessageBinary, data)
}

func (h *CollabDocumentHandler) sendJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func (h *CollabDocumentHandler) sendErrorAndClose(ctx context.Context, conn *websocket.Conn, code string, message string) {
	_ = h.sendJSON(ctx, conn, collabErrorMessage{Type: "error", Code: code, Message: message})
	_ = conn.Close(websocket.StatusPolicyViolation, message)
}

func (h *CollabDocumentHandler) sendErrorAndCloseDetached(conn *websocket.Conn, code string, message string) {
	closeCtx, closeCancel := context.WithTimeout(context.Background(), docWSHeartbeatTimeout)
	defer closeCancel()

	h.sendErrorAndClose(closeCtx, conn, code, message)
}

func addDocPrefix(prefix byte, payload []byte) []byte {
	framed := make([]byte, 1+len(payload))
	framed[0] = prefix
	copy(framed[1:], payload)
	return framed
}

func encodeSyncUpdatePayload(update []byte) ([]byte, error) {
	if len(update) == 0 {
		return nil, fmt.Errorf("empty update payload")
	}

	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteUpdate(encoder, update)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		return nil, fmt.Errorf("encoded empty update payload")
	}
	return payload, nil
}
