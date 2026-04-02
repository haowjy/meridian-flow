package wsutil

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	defaultHeartbeatInterval = 20 * time.Second
	defaultHeartbeatTimeout  = 20 * time.Second
	defaultRateLimitPerSec   = 30
	defaultReadLimitBytes    = 64 * 1024
	defaultNotifyMaxBytes    = 1024

	subscriptionQueueCapacity = 200
	maxSubscriptionsPerConn   = 10
	controlQueueCapacity      = 64
	notifyQueueCapacity       = 64
)

// ErrNotSupported indicates the operation is unsupported by the target handler.
var ErrNotSupported = errors.New("operation not supported")

// State is opaque per-handler state.
type State interface{}

// SubscribeRequest contains a parsed subscribe control message.
type SubscribeRequest struct {
	SubId    string
	Resource Resource
	LastSeq  *int64
	Epoch    *string
}

// Handler processes messages for a specific resource type.
type Handler interface {
	OnConnect(session Session) (State, error)
	OnSubscribe(state State, sub SubscribeRequest) error
	OnUnsubscribe(state State, subId string) error
	OnMessage(state State, msg Envelope) error
	OnDisconnect(state State)
}

// BinaryHandler is optionally implemented by handlers that accept binary WebSocket frames.
type BinaryHandler interface {
	Handler
	OnBinaryMessage(state State, subId string, data []byte) error
}

// Session is the framework-owned egress API for one connection.
type Session interface {
	Send(msg Envelope) error
	SendToSub(subId string, msg Envelope) error
	SendBinaryToSub(subId string, data []byte) error
	EndSub(subId string)
	Notify(msg Envelope) error
	Close(reason string)
	UserID() string
	ProjectID() string
	ConnectionID() string
}

// Broadcaster emits notify-lane events to all project connections.
type Broadcaster interface {
	BroadcastNotify(projectID string, msg Envelope)
}

// HeartbeatConfig controls heartbeat cadence and timeout.
type HeartbeatConfig struct {
	Interval time.Duration
	Timeout  time.Duration
}

// Server handles websocket upgrades and routes envelopes to handlers.
type Server struct {
	authenticator   Authenticator
	heartbeatCfg    HeartbeatConfig
	rateLimitPerSec int
	readLimit       int64
	originPatterns  []string

	logger *slog.Logger

	handlersMu sync.RWMutex
	handlers   map[string]Handler

	projectConns *ProjectConnMap
	now          func() time.Time
	newConnID    func() string
}

type wsConn interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, typ websocket.MessageType, payload []byte) error
	Close(status websocket.StatusCode, reason string) error
	CloseNow() error
	SetReadLimit(limit int64)
}

// Option configures the websocket server.
type Option func(*Server)

// WithAuth sets the authenticator.
func WithAuth(auth Authenticator) Option {
	return func(s *Server) {
		s.authenticator = auth
	}
}

// WithHeartbeat sets heartbeat interval and timeout.
func WithHeartbeat(interval, timeout time.Duration) Option {
	return func(s *Server) {
		if interval > 0 {
			s.heartbeatCfg.Interval = interval
		}
		if timeout > 0 {
			s.heartbeatCfg.Timeout = timeout
		}
	}
}

// WithRateLimit sets inbound per-second message limit per connection.
func WithRateLimit(msgsPerSec int) Option {
	return func(s *Server) {
		if msgsPerSec > 0 {
			s.rateLimitPerSec = msgsPerSec
		}
	}
}

// WithReadLimit sets the websocket read limit.
func WithReadLimit(bytes int64) Option {
	return func(s *Server) {
		if bytes > 0 {
			s.readLimit = bytes
		}
	}
}

// WithOriginPatterns configures allowed websocket origin patterns.
func WithOriginPatterns(patterns ...string) Option {
	return func(s *Server) {
		s.originPatterns = append([]string(nil), patterns...)
	}
}

func withLogger(logger *slog.Logger) Option {
	return func(s *Server) {
		if logger != nil {
			s.logger = logger
		}
	}
}

func withNow(now func() time.Time) Option {
	return func(s *Server) {
		if now != nil {
			s.now = now
		}
	}
}

func withConnID(fn func() string) Option {
	return func(s *Server) {
		if fn != nil {
			s.newConnID = fn
		}
	}
}

// NewServer creates a websocket server with safe defaults.
func NewServer(opts ...Option) *Server {
	s := &Server{
		heartbeatCfg: HeartbeatConfig{
			Interval: defaultHeartbeatInterval,
			Timeout:  defaultHeartbeatTimeout,
		},
		rateLimitPerSec: defaultRateLimitPerSec,
		readLimit:       defaultReadLimitBytes,
		logger:          slog.Default(),
		handlers:        make(map[string]Handler),
		projectConns:    &ProjectConnMap{},
		now:             time.Now,
		newConnID:       uuid.NewString,
	}

	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}

	return s
}

// RegisterHandler registers a handler for a resource type.
func (s *Server) RegisterHandler(resourceType string, h Handler) {
	resourceType = strings.TrimSpace(resourceType)
	if resourceType == "" || h == nil {
		return
	}

	s.handlersMu.Lock()
	s.handlers[resourceType] = h
	s.handlersMu.Unlock()
}

// Serve upgrades an HTTP request into a websocket connection.
func (s *Server) Serve(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.PathValue("projectId"))
	if projectID == "" {
		http.Error(w, "project id is required", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  append([]string(nil), s.originPatterns...),
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		s.logger.Debug("ws upgrade failed", "project_id", projectID, "error", err)
		return
	}

	conn.SetReadLimit(s.readLimit)
	s.serveConn(r.Context(), conn, projectID)
}

func (s *Server) serveConn(parentCtx context.Context, wsConn wsConn, projectID string) {
	authResult, err := BootstrapAuth(parentCtx, wsConn, s.authenticator, projectID)
	if err != nil {
		s.sendAuthFailure(wsConn, err)
		return
	}

	ctx, cancel := context.WithCancel(parentCtx)
	c := newConn(s, wsConn, ctx, cancel, projectID, authResult)

	c.handlerStates = s.snapshotHandlerStates()
	c.runOnConnect()

	s.projectConns.Add(projectID, c)
	defer s.projectConns.Remove(projectID, c.connectionID)

	c.startLoops()
	_ = c.Send(Envelope{
		Kind:    KindControl,
		Op:      OpConnected,
		Payload: MustMarshal(map[string]string{"connectionId": c.connectionID}),
	})

	c.runReadLoop()
	c.cancel()
	c.waitLoops()
	c.cleanup()

	status, reason := c.closeFrame()
	if err := wsConn.Close(status, reason); err != nil {
		_ = wsConn.CloseNow()
	}
}

func (s *Server) sendAuthFailure(conn wsConn, err error) {
	msg := "authentication failed"
	if errors.Is(err, ErrAuthTimeout) {
		msg = "authentication timeout"
	}

	s.logger.Debug("ws authentication failed", "error", err)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	_ = writeTextEnvelope(ctx, conn, NewErrorEnvelope(CodeAuthFailed, msg))
	_ = conn.Close(websocket.StatusPolicyViolation, msg)
}

func (s *Server) snapshotHandlerStates() map[string]*handlerConnState {
	s.handlersMu.RLock()
	defer s.handlersMu.RUnlock()

	out := make(map[string]*handlerConnState, len(s.handlers))
	for resourceType, h := range s.handlers {
		out[resourceType] = &handlerConnState{handler: h}
	}
	return out
}

// BroadcastNotify sends a notify message to all project-scoped connections.
func (s *Server) BroadcastNotify(projectID string, msg Envelope) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return
	}

	msg.Kind = KindNotify
	if len(msg.Payload) > defaultNotifyMaxBytes {
		s.logger.Warn("notify payload exceeds limit", "project_id", projectID, "size", len(msg.Payload))
		return
	}

	for _, c := range s.projectConns.Snapshot(projectID) {
		if err := c.Notify(msg); err != nil {
			s.logger.Debug("broadcast notify failed", "project_id", projectID, "connection_id", c.connectionID, "error", err)
		}
	}
}

// ProjectConnMap stores connections by project id.
type ProjectConnMap struct {
	buckets sync.Map // projectID -> *projectConnBucket
}

type projectConnBucket struct {
	mu    sync.RWMutex
	conns map[string]*conn
}

func (m *ProjectConnMap) Add(projectID string, c *conn) {
	if c == nil || projectID == "" {
		return
	}

	bucketAny, _ := m.buckets.LoadOrStore(projectID, &projectConnBucket{conns: make(map[string]*conn)})
	bucket := bucketAny.(*projectConnBucket)
	bucket.mu.Lock()
	bucket.conns[c.connectionID] = c
	bucket.mu.Unlock()
}

func (m *ProjectConnMap) Remove(projectID, connectionID string) {
	if projectID == "" || connectionID == "" {
		return
	}

	bucketAny, ok := m.buckets.Load(projectID)
	if !ok {
		return
	}
	bucket := bucketAny.(*projectConnBucket)

	bucket.mu.Lock()
	delete(bucket.conns, connectionID)
	empty := len(bucket.conns) == 0
	bucket.mu.Unlock()

	if empty {
		m.buckets.Delete(projectID)
	}
}

func (m *ProjectConnMap) Snapshot(projectID string) []*conn {
	bucketAny, ok := m.buckets.Load(projectID)
	if !ok {
		return nil
	}
	bucket := bucketAny.(*projectConnBucket)

	bucket.mu.RLock()
	out := make([]*conn, 0, len(bucket.conns))
	for _, c := range bucket.conns {
		if c != nil {
			out = append(out, c)
		}
	}
	bucket.mu.RUnlock()

	return out
}

type conn struct {
	server       *Server
	wsConn       wsConn
	ctx          context.Context
	cancel       context.CancelFunc
	connectionID string
	projectID    string
	userID       string
	authResult   *AuthResult

	handlerStates map[string]*handlerConnState

	subMu      sync.RWMutex
	subs       map[string]*subscriptionState
	subOrder   []string
	roundRobin int

	sendQueue   chan Envelope
	notifyQueue chan Envelope
	readyCh     chan struct{}
	pongCh      chan struct{}

	limiter *secondRateLimiter

	loopWG sync.WaitGroup

	closeMu     sync.Mutex
	closeStatus websocket.StatusCode
	closeReason string

	cleanupOnce sync.Once
}

type handlerConnState struct {
	handler  Handler
	state    State
	disabled atomic.Bool
}

type subscriptionState struct {
	subID     string
	resource  Resource
	handlerTy string
	queue     chan outboundMsg
	overflown atomic.Bool
}

type outboundMsg struct {
	text   *Envelope
	binary []byte
}

func newConn(
	server *Server,
	wsConn wsConn,
	ctx context.Context,
	cancel context.CancelFunc,
	projectID string,
	authResult *AuthResult,
) *conn {
	return &conn{
		server:       server,
		wsConn:       wsConn,
		ctx:          ctx,
		cancel:       cancel,
		connectionID: server.newConnID(),
		projectID:    projectID,
		userID:       authResult.UserID,
		authResult:   authResult,
		subs:         make(map[string]*subscriptionState),
		sendQueue:    make(chan Envelope, controlQueueCapacity),
		notifyQueue:  make(chan Envelope, notifyQueueCapacity),
		readyCh:      make(chan struct{}, 1),
		pongCh:       make(chan struct{}, 1),
		limiter:      newSecondRateLimiter(server.rateLimitPerSec),
	}
}

func (c *conn) UserID() string {
	return c.userID
}

func (c *conn) ProjectID() string {
	return c.projectID
}

func (c *conn) ConnectionID() string {
	return c.connectionID
}

func (c *conn) Send(msg Envelope) error {
	if msg.Kind == KindNotify {
		return c.Notify(msg)
	}
	if msg.Kind == KindStream && msg.Op == OpEvent && strings.TrimSpace(msg.SubId) != "" {
		return c.SendToSub(msg.SubId, msg)
	}
	return c.enqueueControl(msg)
}

func (c *conn) Notify(msg Envelope) error {
	msg.Kind = KindNotify
	if len(msg.Payload) > defaultNotifyMaxBytes {
		return fmt.Errorf("notify payload exceeds %d bytes", defaultNotifyMaxBytes)
	}

	select {
	case <-c.ctx.Done():
		return errors.New("connection closed")
	case c.notifyQueue <- msg:
		c.signalReady()
		return nil
	}
}

func (c *conn) SendToSub(subID string, msg Envelope) error {
	subID = strings.TrimSpace(subID)
	if subID == "" {
		return errors.New("sub id is required")
	}

	c.subMu.RLock()
	sub, ok := c.subs[subID]
	c.subMu.RUnlock()
	if !ok {
		return ErrNotSupported
	}

	msg.SubId = subID
	outbound := outboundMsg{text: &msg}
	return c.enqueueSubOutbound(sub, outbound)
}

func (c *conn) SendBinaryToSub(subID string, data []byte) error {
	subID = strings.TrimSpace(subID)
	if subID == "" {
		return errors.New("sub id is required")
	}

	c.subMu.RLock()
	sub, ok := c.subs[subID]
	c.subMu.RUnlock()
	if !ok {
		return ErrNotSupported
	}

	outbound := outboundMsg{binary: frameBinarySubPayload(subID, data)}
	return c.enqueueSubOutbound(sub, outbound)
}

func (c *conn) enqueueSubOutbound(sub *subscriptionState, msg outboundMsg) error {
	if sub == nil {
		return ErrNotSupported
	}
	select {
	case <-c.ctx.Done():
		return errors.New("connection closed")
	case sub.queue <- msg:
		c.signalReady()
		return nil
	default:
		c.handleSubOverflow(sub)
		return nil
	}
}

func (c *conn) EndSub(subID string) {
	c.endSub(subID, false)
}

func (c *conn) endSub(subID string, emitAck bool) {
	sub := c.removeSub(subID)
	if sub == nil {
		return
	}

	// Drain any messages that were already enqueued on the subscription's
	// per-sub queue before EndSub was called. removeSub removes the subID
	// from subOrder so the writer loop's round-robin can no longer find these
	// messages — they would be silently dropped. Reroute them through the
	// control queue so they are still delivered to the client (e.g. catchup
	// events, stream:ended, or gap frames enqueued just before EndSub).
	for {
		select {
		case msg := <-sub.queue:
			if msg.text != nil {
				_ = c.enqueueControl(*msg.text)
			}
		default:
			goto drained
		}
	}
drained:

	if emitAck {
		_ = c.enqueueControl(Envelope{Kind: KindControl, Op: OpUnsubscribed, SubId: subID})
	}

	_ = c.callHandler(sub.handlerTy, func(h Handler, st State) error {
		if h == nil {
			return nil
		}
		return h.OnUnsubscribe(st, subID)
	})
}

func (c *conn) Close(reason string) {
	c.setClose(websocket.StatusNormalClosure, reason)
	c.cancel()
}

func (c *conn) startLoops() {
	c.loopWG.Add(2)
	go c.runWriterLoop()
	go c.runHeartbeatLoop()
}

func (c *conn) waitLoops() {
	c.loopWG.Wait()
}

func (c *conn) runOnConnect() {
	for resourceType, hs := range c.handlerStates {
		if hs == nil || hs.handler == nil {
			continue
		}

		state, err := c.callOnConnect(resourceType, hs)
		if err != nil {
			hs.disabled.Store(true)
			c.server.logger.Error("handler OnConnect failed",
				"resource_type", resourceType,
				"connection_id", c.connectionID,
				"error", err,
			)
			continue
		}
		hs.state = state
	}
}

func (c *conn) runReadLoop() {
	for {
		messageType, data, err := c.wsConn.Read(c.ctx)
		if err != nil {
			if c.ctx.Err() != nil || errors.Is(err, context.Canceled) {
				return
			}

			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
				c.setClose(status, "")
				return
			}

			c.setClose(websocket.StatusGoingAway, "read failure")
			c.server.logger.Debug("ws read failed", "connection_id", c.connectionID, "error", err)
			return
		}

		if allowed, notify := c.limiter.Allow(c.server.now()); !allowed {
			if notify {
				_ = c.enqueueControl(NewErrorEnvelope(CodeRateLimited, "too many inbound messages"))
			}
			continue
		}

		switch messageType {
		case websocket.MessageText:
			env, err := ParseEnvelope(data)
			if err != nil {
				_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "invalid envelope"))
				continue
			}
			c.routeEnvelope(*env)
		case websocket.MessageBinary:
			c.routeBinaryFrame(data)
		default:
			_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "unsupported frame type"))
		}
	}
}

func (c *conn) routeBinaryFrame(frame []byte) {
	nullIdx := bytes.IndexByte(frame, 0x00)
	if nullIdx <= 0 {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "binary frame missing subId prefix"))
		return
	}

	subID := strings.TrimSpace(string(frame[:nullIdx]))
	if subID == "" {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "binary frame missing subId"))
		return
	}
	data := append([]byte(nil), frame[nullIdx+1:]...)

	c.subMu.RLock()
	sub, ok := c.subs[subID]
	c.subMu.RUnlock()
	if !ok {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "unknown subId for binary frame"))
		return
	}

	err := c.callHandler(sub.handlerTy, func(h Handler, st State) error {
		binaryHandler, ok := h.(BinaryHandler)
		if !ok {
			return ErrNotSupported
		}
		return binaryHandler.OnBinaryMessage(st, subID, data)
	})
	if err == nil {
		return
	}

	code := CodeSubscribeFailed
	if errors.Is(err, ErrNotSupported) {
		code = CodeNotSupported
	}
	_ = c.enqueueControl(NewSubErrorEnvelope(subID, &sub.resource, code, err.Error()))
}

func (c *conn) routeEnvelope(msg Envelope) {
	switch msg.Kind {
	case KindControl:
		c.handleControl(msg)
	case KindStream:
		if msg.Op == OpMessage {
			c.handleStreamMessage(msg)
		}
	case KindNotify:
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "notify lane is server-to-client only"))
	case KindError:
		// Ignore client-originated error frames.
	default:
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "unknown message kind"))
	}
}

func (c *conn) handleControl(msg Envelope) {
	switch msg.Op {
	case OpPong:
		select {
		case c.pongCh <- struct{}{}:
		default:
		}
	case OpSubscribe:
		c.handleSubscribe(msg)
	case OpUnsubscribe:
		c.handleUnsubscribe(msg)
	default:
		// Unknown ops are ignored for forward compatibility.
	}
}

func (c *conn) handleSubscribe(msg Envelope) {
	subID := strings.TrimSpace(msg.SubId)
	if subID == "" {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "subscribe requires subId"))
		return
	}
	// Reject NUL bytes in subId — binary frame routing uses NUL as the
	// delimiter between subId and payload. A subId containing NUL would
	// be ambiguous in the binary frame protocol.
	if strings.ContainsRune(subID, 0x00) {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "subId must not contain null bytes"))
		return
	}

	resource, err := parseResource(msg.Resource)
	if err != nil {
		_ = c.enqueueControl(NewSubErrorEnvelope(subID, msg.Resource, CodeInvalidMessage, err.Error()))
		return
	}

	sub, err := c.reserveSub(subID, resource)
	if err != nil {
		_ = c.enqueueControl(NewSubErrorEnvelope(subID, &resource, CodeSubscribeFailed, err.Error()))
		return
	}

	request, err := parseSubscribeRequest(msg, resource)
	if err != nil {
		c.removeSub(subID)
		_ = c.enqueueControl(NewSubErrorEnvelope(subID, &resource, CodeInvalidMessage, err.Error()))
		return
	}

	sub.handlerTy = resource.Type
	err = c.callHandler(resource.Type, func(h Handler, st State) error {
		return h.OnSubscribe(st, request)
	})
	if err == nil {
		return
	}

	c.removeSub(subID)
	code := CodeSubscribeFailed
	if errors.Is(err, ErrNotSupported) {
		code = CodeNotSupported
	}
	_ = c.enqueueControl(NewSubErrorEnvelope(subID, &sub.resource, code, err.Error()))
}

func (c *conn) handleUnsubscribe(msg Envelope) {
	subID := strings.TrimSpace(msg.SubId)
	if subID == "" {
		_ = c.enqueueControl(NewErrorEnvelope(CodeInvalidMessage, "unsubscribe requires subId"))
		return
	}
	c.endSub(subID, true)
}

func (c *conn) handleStreamMessage(msg Envelope) {
	resource, err := parseResource(msg.Resource)
	if err != nil {
		_ = c.enqueueControl(NewSubErrorEnvelope(msg.SubId, msg.Resource, CodeInvalidMessage, err.Error()))
		return
	}

	err = c.callHandler(resource.Type, func(h Handler, st State) error {
		return h.OnMessage(st, msg)
	})
	if err == nil {
		return
	}

	code := CodeSubscribeFailed
	if errors.Is(err, ErrNotSupported) {
		code = CodeNotSupported
	}
	_ = c.enqueueControl(NewSubErrorEnvelope(msg.SubId, &resource, code, err.Error()))
}

func (c *conn) runHeartbeatLoop() {
	defer c.loopWG.Done()

	ticker := time.NewTicker(c.server.heartbeatCfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			if err := ReauthorizeHeartbeat(c.ctx, c.server.authenticator, c.authResult, c.projectID, c.server.now()); err != nil {
				_ = c.enqueueControl(NewErrorEnvelope(CodeAuthFailed, "authentication no longer valid"))
				c.setClose(websocket.StatusPolicyViolation, "reauthorization failed")
				c.cancel()
				return
			}

			c.drainPong()
			if err := c.enqueueControl(Envelope{Kind: KindControl, Op: OpPing}); err != nil {
				c.setClose(websocket.StatusGoingAway, "heartbeat send failed")
				c.cancel()
				return
			}

			timer := time.NewTimer(c.server.heartbeatCfg.Timeout)
			select {
			case <-c.ctx.Done():
				timer.Stop()
				return
			case <-c.pongCh:
				timer.Stop()
			case <-timer.C:
				c.setClose(websocket.StatusPolicyViolation, "heartbeat timeout")
				c.cancel()
				return
			}
		}
	}
}

func (c *conn) runWriterLoop() {
	defer c.loopWG.Done()

	for {
		msg, ok := c.nextOutbound()
		if !ok {
			return
		}

		// Use the connection context for normal writes. If the context is
		// already cancelled (final drain after read-loop exit), use a
		// short standalone timeout so the last envelope still gets sent.
		var writeCtx context.Context
		var cancel context.CancelFunc
		if c.ctx.Err() == nil {
			writeCtx, cancel = context.WithTimeout(c.ctx, c.server.heartbeatCfg.Timeout)
		} else {
			writeCtx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
		}
		err := c.writeOutbound(writeCtx, msg)
		cancel()
		if err != nil {
			c.setClose(websocket.StatusGoingAway, "write failure")
			c.cancel()
			return
		}
	}
}

func (c *conn) writeOutbound(ctx context.Context, msg outboundMsg) error {
	if msg.text != nil {
		return writeTextEnvelope(ctx, c.wsConn, *msg.text)
	}
	if len(msg.binary) > 0 {
		return c.wsConn.Write(ctx, websocket.MessageBinary, msg.binary)
	}
	return nil
}

func (c *conn) nextOutbound() (outboundMsg, bool) {
	for {
		if msg, ok := c.tryDrainControl(); ok {
			return msg, true
		}
		if msg, ok := c.tryDrainNotify(); ok {
			return msg, true
		}
		if msg, ok := c.tryDrainSubRoundRobin(); ok {
			return msg, true
		}

		select {
		case <-c.ctx.Done():
			// Final drain: the read loop may have enqueued a control message
			// (e.g. binary-frame error) just before cancelling the context.
			// Without this, the select randomly picks ctx.Done over readyCh
			// and the final error envelope is never sent.
			if msg, ok := c.tryDrainControl(); ok {
				return msg, true
			}
			return outboundMsg{}, false
		case <-c.readyCh:
		}
	}
}

func (c *conn) tryDrainControl() (outboundMsg, bool) {
	select {
	case msg := <-c.sendQueue:
		return outboundMsg{text: &msg}, true
	default:
		return outboundMsg{}, false
	}
}

func (c *conn) tryDrainNotify() (outboundMsg, bool) {
	select {
	case msg := <-c.notifyQueue:
		return outboundMsg{text: &msg}, true
	default:
		return outboundMsg{}, false
	}
}

func (c *conn) tryDrainSubRoundRobin() (outboundMsg, bool) {
	c.subMu.Lock()
	defer c.subMu.Unlock()

	count := len(c.subOrder)
	if count == 0 {
		c.roundRobin = 0
		return outboundMsg{}, false
	}
	if c.roundRobin >= count {
		c.roundRobin = 0
	}

	for i := 0; i < count; i++ {
		idx := (c.roundRobin + i) % count
		subID := c.subOrder[idx]
		sub := c.subs[subID]
		if sub == nil {
			continue
		}

		select {
		case msg := <-sub.queue:
			c.roundRobin = (idx + 1) % count
			return msg, true
		default:
		}
	}

	return outboundMsg{}, false
}

func (c *conn) handleSubOverflow(sub *subscriptionState) {
	if sub == nil {
		return
	}
	if !sub.overflown.CompareAndSwap(false, true) {
		return
	}

	for {
		select {
		case <-sub.queue:
		default:
			goto drained
		}
	}

drained:
	gapPayload := MustMarshal(map[string]any{"cause": "buffer_full"})
	_ = c.enqueueControl(Envelope{
		Kind:     KindStream,
		Op:       OpGap,
		Resource: &Resource{Type: sub.resource.Type, Id: sub.resource.Id},
		SubId:    sub.subID,
		Payload:  gapPayload,
	})
	c.EndSub(sub.subID)
}

func (c *conn) reserveSub(subID string, resource Resource) (*subscriptionState, error) {
	c.subMu.Lock()
	defer c.subMu.Unlock()

	if _, exists := c.subs[subID]; exists {
		return nil, errors.New("duplicate subId")
	}
	if len(c.subs) >= maxSubscriptionsPerConn {
		return nil, fmt.Errorf("subscription limit reached (%d)", maxSubscriptionsPerConn)
	}

	sub := &subscriptionState{
		subID:    subID,
		resource: resource,
		queue:    make(chan outboundMsg, subscriptionQueueCapacity),
	}
	c.subs[subID] = sub
	c.subOrder = append(c.subOrder, subID)
	return sub, nil
}

func (c *conn) removeSub(subID string) *subscriptionState {
	c.subMu.Lock()
	defer c.subMu.Unlock()

	sub := c.subs[subID]
	if sub == nil {
		return nil
	}
	delete(c.subs, subID)

	for i := range c.subOrder {
		if c.subOrder[i] == subID {
			c.subOrder = append(c.subOrder[:i], c.subOrder[i+1:]...)
			if c.roundRobin > i {
				c.roundRobin--
			}
			break
		}
	}
	if c.roundRobin < 0 {
		c.roundRobin = 0
	}

	return sub
}

func (c *conn) enqueueControl(msg Envelope) error {
	select {
	case <-c.ctx.Done():
		return errors.New("connection closed")
	case c.sendQueue <- msg:
		c.signalReady()
		return nil
	}
}

func (c *conn) signalReady() {
	select {
	case c.readyCh <- struct{}{}:
	default:
	}
}

func (c *conn) drainPong() {
	for {
		select {
		case <-c.pongCh:
		default:
			return
		}
	}
}

func (c *conn) cleanup() {
	c.cleanupOnce.Do(func() {
		var subIDs []string
		c.subMu.RLock()
		subIDs = make([]string, 0, len(c.subs))
		for subID := range c.subs {
			subIDs = append(subIDs, subID)
		}
		c.subMu.RUnlock()

		for _, subID := range subIDs {
			c.EndSub(subID)
		}

		for resourceType, hs := range c.handlerStates {
			if hs == nil || hs.handler == nil || hs.disabled.Load() {
				continue
			}

			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						hs.disabled.Store(true)
						c.server.logger.Error("handler OnDisconnect panic",
							"resource_type", resourceType,
							"connection_id", c.connectionID,
							"panic", recovered,
							"stack", string(debug.Stack()),
						)
					}
				}()
				hs.handler.OnDisconnect(hs.state)
			}()
		}
	})
}

func (c *conn) callOnConnect(resourceType string, hs *handlerConnState) (_ State, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			hs.disabled.Store(true)
			err = fmt.Errorf("handler panic: %v", recovered)
			c.server.logger.Error("handler OnConnect panic",
				"resource_type", resourceType,
				"connection_id", c.connectionID,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
		}
	}()

	return hs.handler.OnConnect(c)
}

func (c *conn) callHandler(resourceType string, call func(h Handler, st State) error) (err error) {
	hs := c.handlerStates[resourceType]
	if hs == nil || hs.handler == nil || hs.disabled.Load() {
		return ErrNotSupported
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			hs.disabled.Store(true)
			err = fmt.Errorf("%w: handler panic", ErrNotSupported)
			c.server.logger.Error("handler panic",
				"resource_type", resourceType,
				"connection_id", c.connectionID,
				"panic", recovered,
				"stack", string(debug.Stack()),
			)
		}
	}()

	return call(hs.handler, hs.state)
}

func (c *conn) setClose(status websocket.StatusCode, reason string) {
	c.closeMu.Lock()
	if c.closeStatus == 0 {
		c.closeStatus = status
		c.closeReason = reason
	}
	c.closeMu.Unlock()
}

func (c *conn) closeFrame() (websocket.StatusCode, string) {
	c.closeMu.Lock()
	defer c.closeMu.Unlock()

	if c.closeStatus == 0 {
		return websocket.StatusNormalClosure, "connection closed"
	}
	return c.closeStatus, c.closeReason
}

type secondRateLimiter struct {
	limit int

	mu           sync.Mutex
	windowSecond int64
	count        int
	notified     bool
}

func newSecondRateLimiter(limit int) *secondRateLimiter {
	if limit <= 0 {
		limit = defaultRateLimitPerSec
	}
	return &secondRateLimiter{limit: limit}
}

// Allow returns (allowed, notifyClient).
func (l *secondRateLimiter) Allow(now time.Time) (bool, bool) {
	second := now.Unix()

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.windowSecond != second {
		l.windowSecond = second
		l.count = 0
		l.notified = false
	}

	l.count++
	if l.count <= l.limit {
		return true, false
	}

	if !l.notified {
		l.notified = true
		return false, true
	}
	return false, false
}

func frameBinarySubPayload(subID string, data []byte) []byte {
	framed := make([]byte, len(subID)+1+len(data))
	copy(framed, subID)
	copy(framed[len(subID)+1:], data)
	return framed
}

func parseResource(resource *Resource) (Resource, error) {
	if resource == nil {
		return Resource{}, errors.New("resource is required")
	}

	typ := strings.TrimSpace(resource.Type)
	id := strings.TrimSpace(resource.Id)
	if typ == "" || id == "" {
		return Resource{}, errors.New("resource.type and resource.id are required")
	}
	return Resource{Type: typ, Id: id}, nil
}

func parseSubscribeRequest(msg Envelope, resource Resource) (SubscribeRequest, error) {
	var payload struct {
		LastSeq *int64  `json:"lastSeq"`
		Epoch   *string `json:"epoch"`
	}

	if len(msg.Payload) > 0 {
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return SubscribeRequest{}, errors.New("invalid subscribe payload")
		}
	}

	return SubscribeRequest{
		SubId:    msg.SubId,
		Resource: resource,
		LastSeq:  payload.LastSeq,
		Epoch:    payload.Epoch,
	}, nil
}

func writeTextEnvelope(ctx context.Context, wsConn wsConn, msg Envelope) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return wsConn.Write(ctx, websocket.MessageText, body)
}

func MustMarshal(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}
