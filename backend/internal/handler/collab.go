package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/auth"
	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	collab "meridian/internal/domain/collab"
)

// CollabHandler handles collaboration transport entrypoints.
type CollabHandler struct {
	documentResolver collab.DocumentResolver
	proposalService  collab.ProposalService
	proposalStore    collab.ProposalStore
	authenticator    *collabAuthenticator
	logger           *slog.Logger
	config           *config.Config

	// projectRegistry tracks project WS connections and broadcasts JSON proposal events.
	projectRegistry ProjectConnectionRegistry

	// docHandler provides document-level binary fanout for server-initiated Yjs updates.
	docHandler DocumentBroadcaster
}

const (
	collabAuthMessageTimeout = 5 * time.Second
	collabMaxMessageBytes    = 64 * 1024
	collabHeartbeatInterval  = 30 * time.Second
	collabHeartbeatTimeout   = 5 * time.Second
	collabInboundRateLimit   = 30
)

const (
	collabInboundRateWindow = time.Second
	collabInboundMutePeriod = time.Second
)

type collabErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type collabHeartbeatMessage struct {
	Type string `json:"type"`
}

type collabInboundRateTracker struct {
	windowStart time.Time
	windowCount int
	mutedUntil  time.Time
}

func (t *collabInboundRateTracker) allowInbound(now time.Time) (allowed bool, limitExceeded bool) {
	if now.Before(t.mutedUntil) {
		return false, false
	}

	if t.windowStart.IsZero() || now.Sub(t.windowStart) >= collabInboundRateWindow {
		t.windowStart = now
		t.windowCount = 0
	}

	t.windowCount++
	if t.windowCount > collabInboundRateLimit {
		t.mutedUntil = now.Add(collabInboundMutePeriod)
		return false, true
	}

	return true, false
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
	if isLikelyJSONMessage(data) {
		return websocket.Message.Send(c.conn, string(data))
	}
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
	documentResolver collab.DocumentResolver,
	proposalService collab.ProposalService,
	proposalStore collab.ProposalStore,
	jwtVerifier auth.JWTVerifier,
	authorizer authdomain.ResourceAuthorizer,
	logger *slog.Logger,
	cfg *config.Config,
	projectRegistry ProjectConnectionRegistry,
	docHandler DocumentBroadcaster,
) *CollabHandler {
	var isIdentityBlocked func(string, string) bool
	if cfg != nil {
		isIdentityBlocked = cfg.IsProdIdentityBlocked
	}

	return &CollabHandler{
		documentResolver: documentResolver,
		proposalService:  proposalService,
		proposalStore:    proposalStore,
		authenticator:    newCollabAuthenticator(jwtVerifier, authorizer, documentResolver, isIdentityBlocked, logger),
		logger:           logger,
		config:           cfg,
		projectRegistry:  projectRegistry,
		docHandler:       docHandler,
	}
}

func (h *CollabHandler) runHeartbeatLoop(
	conn *websocketDocumentConnection,
	acks <-chan struct{},
	stop <-chan struct{},
	jwtExpiry time.Time,
) {
	ticker := time.NewTicker(collabHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if !jwtExpiry.IsZero() && time.Now().After(jwtExpiry) {
				h.sendError(conn, "AUTH_EXPIRED", domain.ErrAuthExpired.Error())
				if err := conn.Close(); err != nil {
					h.logger.Debug("collab heartbeat auth expiry close failed", "error", err)
				}
				return
			}

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

func isLikelyJSONMessage(raw []byte) bool {
	if len(raw) == 0 || raw[0] != '{' {
		return false
	}
	return json.Valid(raw)
}

// nonBlockingSignal sends a signal without blocking if the channel is full.
func nonBlockingSignal(ch chan<- struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// drainSignalChannel discards all pending signals so the next receive blocks on a fresh signal.
func drainSignalChannel(ch <-chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}
