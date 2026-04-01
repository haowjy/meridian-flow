package wsutil

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type wsTestAuthenticator struct {
	accessErr error

	mu    sync.Mutex
	calls int
}

func (a *wsTestAuthenticator) Authenticate(_ string) (*AuthResult, error) {
	return &AuthResult{UserID: "user-1", ExpiresAt: time.Now().Add(30 * time.Minute)}, nil
}

func (a *wsTestAuthenticator) CheckProjectAccess(_ context.Context, _ string, _ string) error {
	a.mu.Lock()
	a.calls++
	a.mu.Unlock()
	return a.accessErr
}

type wsTestHandler struct {
	onConnect     func(session Session) (State, error)
	onSubscribe   func(state State, sub SubscribeRequest) error
	onUnsubscribe func(state State, subID string) error
	onMessage     func(state State, msg Envelope) error
	onDisconnect  func(state State)
}

func (h *wsTestHandler) OnConnect(session Session) (State, error) {
	if h.onConnect != nil {
		return h.onConnect(session)
	}
	return nil, nil
}

func (h *wsTestHandler) OnSubscribe(state State, sub SubscribeRequest) error {
	if h.onSubscribe != nil {
		return h.onSubscribe(state, sub)
	}
	return nil
}

func (h *wsTestHandler) OnUnsubscribe(state State, subID string) error {
	if h.onUnsubscribe != nil {
		return h.onUnsubscribe(state, subID)
	}
	return nil
}

func (h *wsTestHandler) OnMessage(state State, msg Envelope) error {
	if h.onMessage != nil {
		return h.onMessage(state, msg)
	}
	return nil
}

func (h *wsTestHandler) OnDisconnect(state State) {
	if h.onDisconnect != nil {
		h.onDisconnect(state)
	}
}

type wsBinaryTestHandler struct {
	wsTestHandler
	onBinary func(state State, subID string, data []byte) error
}

func (h *wsBinaryTestHandler) OnBinaryMessage(state State, subID string, data []byte) error {
	if h.onBinary != nil {
		return h.onBinary(state, subID, data)
	}
	return nil
}

type wsFrame struct {
	typeID websocket.MessageType
	data   []byte
	err    error
}

type fakeWSConn struct {
	inbound  chan wsFrame
	outbound chan wsFrame

	mu          sync.Mutex
	closed      bool
	closeStatus websocket.StatusCode
	closeReason string
	readLimit   int64
}

func newFakeWSConn() *fakeWSConn {
	return &fakeWSConn{
		inbound:  make(chan wsFrame, 256),
		outbound: make(chan wsFrame, 256),
	}
}

func (c *fakeWSConn) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case frame := <-c.inbound:
		if frame.err != nil {
			return 0, nil, frame.err
		}
		return frame.typeID, append([]byte(nil), frame.data...), nil
	}
}

func (c *fakeWSConn) Write(ctx context.Context, typ websocket.MessageType, payload []byte) error {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return io.EOF
	}

	frame := wsFrame{typeID: typ, data: append([]byte(nil), payload...)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case c.outbound <- frame:
		return nil
	}
}

func (c *fakeWSConn) Close(status websocket.StatusCode, reason string) error {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		c.closeStatus = status
		c.closeReason = reason
	}
	c.mu.Unlock()
	return nil
}

func (c *fakeWSConn) CloseNow() error {
	return c.Close(websocket.StatusNormalClosure, "")
}

func (c *fakeWSConn) SetReadLimit(limit int64) {
	c.mu.Lock()
	c.readLimit = limit
	c.mu.Unlock()
}

func (c *fakeWSConn) pushTextEnvelope(t *testing.T, msg Envelope) {
	t.Helper()
	body, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	c.inbound <- wsFrame{typeID: websocket.MessageText, data: body}
}

func (c *fakeWSConn) pushBinary(data []byte) {
	c.inbound <- wsFrame{typeID: websocket.MessageBinary, data: append([]byte(nil), data...)}
}

func (c *fakeWSConn) pushReadError(err error) {
	c.inbound <- wsFrame{err: err}
}

func (c *fakeWSConn) readServerEnvelope(t *testing.T, timeout time.Duration) Envelope {
	t.Helper()
	select {
	case frame := <-c.outbound:
		if frame.typeID != websocket.MessageText {
			t.Fatalf("expected text frame, got %v", frame.typeID)
		}
		env, err := ParseEnvelope(frame.data)
		if err != nil {
			t.Fatalf("parse envelope: %v", err)
		}
		return *env
	case <-time.After(timeout):
		t.Fatal("timed out waiting for outbound frame")
		return Envelope{}
	}
}

func (c *fakeWSConn) tryReadServerEnvelope(timeout time.Duration) (Envelope, bool) {
	select {
	case frame := <-c.outbound:
		if frame.typeID != websocket.MessageText {
			return Envelope{}, false
		}
		env, err := ParseEnvelope(frame.data)
		if err != nil {
			return Envelope{}, false
		}
		return *env, true
	case <-time.After(timeout):
		return Envelope{}, false
	}
}

func (c *fakeWSConn) readServerBinary(t *testing.T, timeout time.Duration) []byte {
	t.Helper()
	select {
	case frame := <-c.outbound:
		if frame.typeID != websocket.MessageBinary {
			t.Fatalf("expected binary frame, got %v", frame.typeID)
		}
		return append([]byte(nil), frame.data...)
	case <-time.After(timeout):
		t.Fatal("timed out waiting for outbound binary frame")
		return nil
	}
}

func startServeConn(t *testing.T, s *Server, projectID string) (*fakeWSConn, <-chan struct{}) {
	t.Helper()
	fake := newFakeWSConn()
	done := make(chan struct{})
	go func() {
		s.serveConn(context.Background(), fake, projectID)
		close(done)
	}()
	return fake, done
}

func stopServeConn(t *testing.T, fake *fakeWSConn, done <-chan struct{}) {
	t.Helper()
	fake.pushReadError(io.EOF)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for serveConn to exit")
	}
}

func TestServerConnectionLifecycle(t *testing.T) {
	auth := &wsTestAuthenticator{}
	connected := make(chan struct{}, 1)
	disconnected := make(chan struct{}, 1)

	handler := &wsTestHandler{
		onConnect: func(_ Session) (State, error) {
			connected <- struct{}{}
			return nil, nil
		},
		onDisconnect: func(_ State) {
			disconnected <- struct{}{}
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(30*time.Millisecond, 50*time.Millisecond),
		withLogger(testLogger()),
		withConnID(func() string { return "conn-fixed" }),
	)
	s.RegisterHandler("turn", handler)

	fake, done := startServeConn(t, s, "project-1")

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	connectedMsg := fake.readServerEnvelope(t, time.Second)
	if connectedMsg.Kind != KindControl || connectedMsg.Op != OpConnected {
		t.Fatalf("expected connected, got %+v", connectedMsg)
	}

	var payload struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := json.Unmarshal(connectedMsg.Payload, &payload); err != nil {
		t.Fatalf("unmarshal connected payload: %v", err)
	}
	if payload.ConnectionID != "conn-fixed" {
		t.Fatalf("unexpected connection id: %s", payload.ConnectionID)
	}

	ping := fake.readServerEnvelope(t, time.Second)
	if ping.Kind != KindControl || ping.Op != OpPing {
		t.Fatalf("expected ping, got %+v", ping)
	}
	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpPong})

	select {
	case <-connected:
	case <-time.After(time.Second):
		t.Fatal("expected OnConnect callback")
	}

	stopServeConn(t, fake, done)

	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("expected OnDisconnect callback")
	}
}

func TestSubscribeLimitAndDuplicateSubID(t *testing.T) {
	auth := &wsTestAuthenticator{}
	var subscribeCalls atomic.Int32

	handler := &wsTestHandler{
		onSubscribe: func(_ State, _ SubscribeRequest) error {
			subscribeCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", handler)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	for i := 1; i <= 10; i++ {
		fake.pushTextEnvelope(t, Envelope{
			Kind:     KindControl,
			Op:       OpSubscribe,
			SubId:    "sub-" + itoa(i),
			Resource: &Resource{Type: "turn", Id: "turn-1"},
		})
	}

	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindControl,
		Op:       OpSubscribe,
		SubId:    "sub-11",
		Resource: &Resource{Type: "turn", Id: "turn-1"},
	})
	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindControl,
		Op:       OpSubscribe,
		SubId:    "sub-1",
		Resource: &Resource{Type: "turn", Id: "turn-1"},
	})

	errorOne := fake.readServerEnvelope(t, time.Second)
	errorTwo := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errorOne, CodeSubscribeFailed)
	assertErrorCode(t, errorTwo, CodeSubscribeFailed)

	if !waitFor(time.Second, func() bool { return subscribeCalls.Load() == 10 }) {
		t.Fatalf("expected 10 subscribe calls, got %d", subscribeCalls.Load())
	}
}

func TestBackpressureOverflowSendsGapAndEndsSubscription(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var unsubCalls atomic.Int32
	handler := &wsTestHandler{
		onUnsubscribe: func(_ State, _ string) error {
			unsubCalls.Add(1)
			return nil
		},
	}

	c := &conn{
		server:       NewServer(withLogger(testLogger())),
		ctx:          ctx,
		cancel:       cancel,
		connectionID: "conn-1",
		projectID:    "project-1",
		userID:       "user-1",
		subs:         make(map[string]*subscriptionState),
		sendQueue:    make(chan Envelope, 8),
		notifyQueue:  make(chan Envelope, 8),
		readyCh:      make(chan struct{}, 1),
		pongCh:       make(chan struct{}, 1),
		handlerStates: map[string]*handlerConnState{
			"turn": {handler: handler},
		},
	}

	sub := &subscriptionState{
		subID:     "sub-1",
		resource:  Resource{Type: "turn", Id: "turn-1"},
		handlerTy: "turn",
		queue:     make(chan outboundMsg, subscriptionQueueCapacity),
	}
	for i := 0; i < subscriptionQueueCapacity; i++ {
		msg := Envelope{Kind: KindStream, Op: OpEvent, SubId: "sub-1"}
		sub.queue <- outboundMsg{text: &msg}
	}
	c.subs["sub-1"] = sub
	c.subOrder = []string{"sub-1"}

	if err := c.SendToSub("sub-1", Envelope{Kind: KindStream, Op: OpEvent}); err != nil {
		t.Fatalf("SendToSub returned error: %v", err)
	}

	if _, exists := c.subs["sub-1"]; exists {
		t.Fatal("expected subscription removal after overflow")
	}
	if unsubCalls.Load() != 1 {
		t.Fatalf("expected one OnUnsubscribe call, got %d", unsubCalls.Load())
	}

	select {
	case msg := <-c.sendQueue:
		if msg.Kind != KindStream || msg.Op != OpGap || msg.SubId != "sub-1" {
			t.Fatalf("unexpected overflow message: %+v", msg)
		}
	default:
		t.Fatal("expected gap message")
	}
}

func TestRateLimitDropsExcessMessages(t *testing.T) {
	auth := &wsTestAuthenticator{}
	fixed := time.Unix(1234, 0)
	var onMessageCalls atomic.Int32

	handler := &wsTestHandler{
		onMessage: func(_ State, _ Envelope) error {
			onMessageCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithRateLimit(2),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withNow(func() time.Time { return fixed }),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", handler)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	for i := 0; i < 6; i++ {
		fake.pushTextEnvelope(t, Envelope{
			Kind:     KindStream,
			Op:       OpMessage,
			Resource: &Resource{Type: "turn", Id: "turn-1"},
			Payload:  mustMarshal(map[string]int{"n": i}),
		})
	}

	if !waitFor(time.Second, func() bool { return onMessageCalls.Load() == 2 }) {
		t.Fatalf("expected 2 handled messages, got %d", onMessageCalls.Load())
	}

	rateErr := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, rateErr, CodeRateLimited)
}

func TestHandlerPanicRecoveryKeepsConnectionAlive(t *testing.T) {
	auth := &wsTestAuthenticator{}
	var safeCalls atomic.Int32

	panicHandler := &wsTestHandler{
		onMessage: func(_ State, _ Envelope) error {
			panic("boom")
		},
	}
	safeHandler := &wsTestHandler{
		onMessage: func(_ State, _ Envelope) error {
			safeCalls.Add(1)
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("panic", panicHandler)
	s.RegisterHandler("safe", safeHandler)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushTextEnvelope(t, Envelope{Kind: KindStream, Op: OpMessage, Resource: &Resource{Type: "panic", Id: "r1"}})
	fake.pushTextEnvelope(t, Envelope{Kind: KindStream, Op: OpMessage, Resource: &Resource{Type: "safe", Id: "r2"}})
	fake.pushTextEnvelope(t, Envelope{Kind: KindStream, Op: OpMessage, Resource: &Resource{Type: "safe", Id: "r2"}})

	if !waitFor(time.Second, func() bool { return safeCalls.Load() == 2 }) {
		t.Fatalf("expected safe handler calls after panic, got %d", safeCalls.Load())
	}
}

func TestBroadcastNotifyTargetsProjectConnectionsOnly(t *testing.T) {
	auth := &wsTestAuthenticator{}
	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)

	fakeA, doneA := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fakeA, doneA)
	fakeA.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fakeA.readServerEnvelope(t, time.Second)

	fakeB, doneB := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fakeB, doneB)
	fakeB.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fakeB.readServerEnvelope(t, time.Second)

	fakeC, doneC := startServeConn(t, s, "project-2")
	defer stopServeConn(t, fakeC, doneC)
	fakeC.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fakeC.readServerEnvelope(t, time.Second)

	s.BroadcastNotify("project-1", Envelope{
		Op:       OpInvalidate,
		Resource: &Resource{Type: "turn", Id: "turn-1"},
		Payload:  mustMarshal(map[string]string{"event": "updated"}),
	})

	msgA := fakeA.readServerEnvelope(t, time.Second)
	msgB := fakeB.readServerEnvelope(t, time.Second)
	assertNotifyInvalidate(t, msgA)
	assertNotifyInvalidate(t, msgB)

	if _, ok := fakeC.tryReadServerEnvelope(150 * time.Millisecond); ok {
		t.Fatal("expected no notify for other project")
	}
}

func TestBinaryFrameWithoutPrefixReturnsError(t *testing.T) {
	auth := &wsTestAuthenticator{}
	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushBinary([]byte{0x01, 0x02})
	errMsg := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errMsg, CodeInvalidMessage)
	if _, ok := fake.tryReadServerEnvelope(100 * time.Millisecond); ok {
		t.Fatal("expected no extra frames after malformed binary frame")
	}
}

func TestBinaryFrameToNonBinaryHandlerReturnsNotSupported(t *testing.T) {
	auth := &wsTestAuthenticator{}
	handler := &wsTestHandler{}
	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", handler)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindControl,
		Op:       OpSubscribe,
		SubId:    "sub-1",
		Resource: &Resource{Type: "turn", Id: "turn-1"},
	})

	fake.pushBinary(append([]byte("sub-1\x00"), []byte{0xAA}...))
	errMsg := fake.readServerEnvelope(t, time.Second)
	assertErrorCode(t, errMsg, CodeNotSupported)
}

func TestBinaryFrameDeliveredToBinaryHandlerAndBinaryEgress(t *testing.T) {
	auth := &wsTestAuthenticator{}
	binaryCalls := make(chan struct {
		subID string
		data  []byte
	}, 1)

	type binaryState struct {
		session Session
	}

	handler := &wsBinaryTestHandler{
		wsTestHandler: wsTestHandler{
			onConnect: func(session Session) (State, error) {
				return &binaryState{session: session}, nil
			},
			onSubscribe: func(state State, sub SubscribeRequest) error {
				st, ok := state.(*binaryState)
				if !ok || st == nil {
					return errors.New("invalid state")
				}
				return st.session.SendBinaryToSub(sub.SubId, []byte{0xBC})
			},
		},
		onBinary: func(_ State, subID string, data []byte) error {
			binaryCalls <- struct {
				subID string
				data  []byte
			}{subID: subID, data: append([]byte(nil), data...)}
			return nil
		},
	}

	s := NewServer(
		WithAuth(auth),
		WithHeartbeat(10*time.Second, 10*time.Second),
		withLogger(testLogger()),
	)
	s.RegisterHandler("turn", handler)

	fake, done := startServeConn(t, s, "project-1")
	defer stopServeConn(t, fake, done)

	fake.pushTextEnvelope(t, Envelope{Kind: KindControl, Op: OpAuth, Payload: mustMarshal(map[string]string{"token": "ok"})})
	_ = fake.readServerEnvelope(t, time.Second) // connected

	fake.pushTextEnvelope(t, Envelope{
		Kind:     KindControl,
		Op:       OpSubscribe,
		SubId:    "sub-1",
		Resource: &Resource{Type: "turn", Id: "turn-1"},
	})

	outboundBinary := fake.readServerBinary(t, time.Second)
	wantBinary := append([]byte("sub-1\x00"), byte(0xBC))
	if string(outboundBinary) != string(wantBinary) {
		t.Fatalf("unexpected binary egress frame: got=%v want=%v", outboundBinary, wantBinary)
	}

	fake.pushBinary(append([]byte("sub-1\x00"), []byte{0xDE, 0xAD}...))
	if !waitFor(time.Second, func() bool { return len(binaryCalls) == 1 }) {
		t.Fatal("expected binary handler to receive inbound frame")
	}
	call := <-binaryCalls
	if call.subID != "sub-1" {
		t.Fatalf("unexpected binary handler subID: %q", call.subID)
	}
	if len(call.data) != 2 || call.data[0] != 0xDE || call.data[1] != 0xAD {
		t.Fatalf("unexpected binary payload delivered to handler: %v", call.data)
	}

	if _, ok := fake.tryReadServerEnvelope(100 * time.Millisecond); ok {
		t.Fatal("expected no error envelopes for valid binary frame path")
	}
}

func assertErrorCode(t *testing.T, msg Envelope, want string) {
	t.Helper()
	if msg.Kind != KindError || msg.Op != OpError {
		t.Fatalf("expected error envelope, got %+v", msg)
	}
	payload, err := ParseErrorPayload(msg.Payload)
	if err != nil {
		t.Fatalf("parse error payload: %v", err)
	}
	if payload.Code != want {
		t.Fatalf("expected error code %q, got %q", want, payload.Code)
	}
}

func assertNotifyInvalidate(t *testing.T, msg Envelope) {
	t.Helper()
	if msg.Kind != KindNotify || msg.Op != OpInvalidate {
		t.Fatalf("expected notify invalidate, got %+v", msg)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}

	buf := [16]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
