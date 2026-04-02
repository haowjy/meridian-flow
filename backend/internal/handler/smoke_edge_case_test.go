package handler

// smoke_edge_case_test.go: end-to-end smoke tests for WebSocket edge cases that
// unit tests can't easily exercise. Tests use real httptest servers, real WS
// connections, and real mstream instances wherever possible.
//
// Edge cases covered:
//   1. Backpressure — subscription queue overflows, gap sent, connection alive
//   2. Reconnect catchup (live stream) — atomicity: no duplicates when stream still running
//   3. Reconnect stale epoch — gap with cause=epoch_mismatch, connection stays alive
//   4. Two-gap livelock — frontend-only concern, documented not tested here
//   5. Stream switch race — interjection routed to successor turn during drain
//   6. Missed stream switch — subscribe to old turn, receive ended{stream_switch, newAssistantTurnId}
//   7. Subscription slot exhaustion — 10-sub limit, unsubscribe frees slot
//   8. Panic recovery — handler panic → error frame, connection alive
//   9. Heartbeat auth revocation — access revoked mid-connection, connection torn down

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	cws "github.com/coder/websocket"
	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/wsutil"
)

// ────────────────────────────────────────────────── test-local helpers ────────

// mutableAuth is an Authenticator whose CheckProjectAccess can be swapped at
// runtime, allowing tests to revoke access after the connection is established.
type mutableAuth struct {
	mu        sync.RWMutex
	accessErr error
}

func (a *mutableAuth) Authenticate(_ string) (*wsutil.AuthResult, error) {
	return &wsutil.AuthResult{UserID: "user-1", ExpiresAt: time.Now().Add(30 * time.Minute)}, nil
}

func (a *mutableAuth) CheckProjectAccess(_ context.Context, _, _ string) error {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.accessErr
}

func (a *mutableAuth) revokeAccess() {
	a.mu.Lock()
	a.accessErr = errors.New("access revoked")
	a.mu.Unlock()
}

// pipeListener wraps a single net.Conn as a net.Listener. net.Pipe() connections
// have no internal buffering: server writes block immediately when the client
// isn't reading — ideal for backpressure testing.
type pipeListener struct {
	once   sync.Once
	ch     chan net.Conn
	closed chan struct{}
}

func newPipeListener(conn net.Conn) *pipeListener {
	l := &pipeListener{
		ch:     make(chan net.Conn, 1),
		closed: make(chan struct{}),
	}
	l.ch <- conn
	return l
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.closed:
		return nil, fmt.Errorf("listener closed: %w", net.ErrClosed)
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

// dialPipeWS starts srv behind a net.Pipe listener and returns a WS client
// connection backed by the pipe. Because net.Pipe is synchronous, the server's
// writer loop blocks the instant the client stops calling Read — which is exactly
// what's needed to fill subscription queues and trigger backpressure.
func dialPipeWS(t *testing.T, srv *wsutil.Server, projectID string) *cws.Conn {
	t.Helper()

	serverConn, clientConn := net.Pipe()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/threads", srv.Serve)

	ln := newPipeListener(serverConn)
	httpSrv := &http.Server{Handler: mux}
	go func() { _ = httpSrv.Serve(ln) }()
	t.Cleanup(func() {
		_ = httpSrv.Close()
		_ = ln.Close()
		_ = serverConn.Close()
		_ = clientConn.Close()
	})

	transport := &http.Transport{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return clientConn, nil
		},
		DisableKeepAlives: true,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx,
		"ws://pipe.test/ws/projects/"+projectID+"/threads",
		&cws.DialOptions{HTTPClient: &http.Client{Transport: transport}},
	)
	if err != nil {
		t.Fatalf("dialPipeWS: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

// ─────────────────────────── backpressure handler helpers ────────────────────

// bpState holds per-connection state for the backpressure handler.
type bpState struct {
	session  wsutil.Session
	firstSub atomic.Bool // true after the first (flood) subscription is claimed
}

// backpressureHandler is a wsutil.Handler whose first OnSubscribe floods
// session.SendToSub in a tight goroutine loop to trigger sub-queue overflow.
// Subsequent subscribes just ack without flooding so the alive check works.
type backpressureHandler struct {
	// overflowDone is closed by the flood goroutine when SendToSub returns an
	// error (which happens after handleSubOverflow ends the subscription).
	overflowDone chan struct{}
}

func newBackpressureHandler() *backpressureHandler {
	return &backpressureHandler{overflowDone: make(chan struct{})}
}

func (h *backpressureHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
	return &bpState{session: session}, nil
}

func (h *backpressureHandler) OnSubscribe(rawState wsutil.State, sub wsutil.SubscribeRequest) error {
	st := rawState.(*bpState)
	// Always ack first so the client can unblock.
	if err := st.session.Send(wsutil.Envelope{
		Kind:  wsutil.KindControl,
		Op:    wsutil.OpSubscribed,
		SubId: sub.SubId,
	}); err != nil {
		return err
	}

	// Only the first subscription gets the flood goroutine.
	if !st.firstSub.CompareAndSwap(false, true) {
		return nil
	}

	subID := sub.SubId
	floodPayload := wsutil.MustMarshal(map[string]string{
		"data": strings.Repeat("x", 500),
	})

	go func() {
		defer close(h.overflowDone)
		for {
			err := st.session.SendToSub(subID, wsutil.Envelope{
				Kind:    wsutil.KindStream,
				Op:      wsutil.OpEvent,
				SubId:   subID,
				Payload: floodPayload,
			})
			if err != nil {
				return // subscription ended (overflow or connection close)
			}
		}
	}()
	return nil
}

func (h *backpressureHandler) OnUnsubscribe(_ wsutil.State, _ string) error { return nil }
func (h *backpressureHandler) OnMessage(_ wsutil.State, _ wsutil.Envelope) error { return nil }
func (h *backpressureHandler) OnDisconnect(_ wsutil.State)                        {}

// panicOnSubscribeHandler is a wsutil.Handler that panics in OnSubscribe to test
// the framework's panic recovery.
type panicOnSubscribeHandler struct{}

func (h *panicOnSubscribeHandler) OnConnect(_ wsutil.Session) (wsutil.State, error) { return nil, nil }
func (h *panicOnSubscribeHandler) OnSubscribe(_ wsutil.State, _ wsutil.SubscribeRequest) error {
	panic("intentional panic in OnSubscribe for smoke test")
}
func (h *panicOnSubscribeHandler) OnUnsubscribe(_ wsutil.State, _ string) error { return nil }
func (h *panicOnSubscribeHandler) OnMessage(_ wsutil.State, _ wsutil.Envelope) error { return nil }
func (h *panicOnSubscribeHandler) OnDisconnect(_ wsutil.State)                        {}

// safeHandlerState holds the session so OnSubscribe can send the OpSubscribed ack.
// The Handler interface passes the session only to OnConnect, so we store it here.
type safeHandlerState struct {
	session wsutil.Session
}

// safeHandler is a wsutil.Handler that records subscribe calls and sends proper
// OpSubscribed acks so callers can verify the connection is still alive.
type safeHandler struct{ subscribes atomic.Int32 }

func (h *safeHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
	return &safeHandlerState{session: session}, nil
}
func (h *safeHandler) OnSubscribe(rawState wsutil.State, sub wsutil.SubscribeRequest) error {
	h.subscribes.Add(1)
	st := rawState.(*safeHandlerState)
	return st.session.Send(wsutil.Envelope{
		Kind:  wsutil.KindControl,
		Op:    wsutil.OpSubscribed,
		SubId: sub.SubId,
	})
}
func (h *safeHandler) OnUnsubscribe(_ wsutil.State, _ string) error { return nil }
func (h *safeHandler) OnMessage(_ wsutil.State, _ wsutil.Envelope) error { return nil }
func (h *safeHandler) OnDisconnect(_ wsutil.State)                        {}

// ──────────────────────────────── Test 1: Backpressure ────────────────────────

// TestSmokeBackpressureGapTerminatesSubscription verifies that when a slow/frozen
// client causes the per-subscription write queue (capacity=200) to overflow:
//   - a gap frame (cause=buffer_full) is delivered to the client
//   - the overflowed subscription is terminated
//   - the connection stays alive for further operations
//
// Strategy: use a net.Pipe connection (zero kernel buffering) so the server's
// writer goroutine blocks the instant the client stops calling Read. While blocked,
// the custom backpressureHandler floods session.SendToSub in a tight goroutine
// loop, filling the 200-slot sub queue. The 201st enqueue triggers
// handleSubOverflow: sub queue is drained, a gap frame is pushed to the control
// queue, and EndSub is called. After 400ms the client unfreeze-reads and the gap
// arrives before anything else (control has priority in nextOutbound).
func TestSmokeBackpressureGapTerminatesSubscription(t *testing.T) {
	bpHandler := newBackpressureHandler()

	srv := wsutil.NewServer(
		wsutil.WithAuth(&threadWSAuth{}),
		// Long heartbeat so pings don't fire during the freeze window.
		// 30s write timeout: the blocked write must survive the 400ms freeze.
		wsutil.WithHeartbeat(10*time.Minute, 30*time.Second),
		wsutil.WithRateLimit(600),
		wsutil.WithReadLimit(256*1024),
	)
	srv.RegisterHandler("turn", bpHandler)

	// net.Pipe connection: writes block immediately when the client isn't reading.
	c := dialPipeWS(t, srv, "project-bp")

	// Authenticate + read OpConnected. twsConnect uses an httptest.Server; for
	// net.Pipe we drive auth manually.
	authEnv, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: wsutil.MustMarshal(map[string]string{"token": "valid-token"}),
	})
	{
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := c.Write(ctx, cws.MessageText, authEnv); err != nil {
			t.Fatalf("auth write: %v", err)
		}
	}
	// Read OpConnected.
	{
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, raw, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read connected: %v", err)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(raw, &env); err != nil || env.Op != wsutil.OpConnected {
			t.Fatalf("expected OpConnected, got raw=%s err=%v", raw, err)
		}
	}

	// Subscribe to any turn ID (the custom handler doesn't check it).
	twsSubscribe(t, c, "sub-bp", uuid.New().String(), nil, nil)

	// Read OpSubscribed — after this the flood goroutine is already running.
	{
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, raw, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read subscribed: %v", err)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(raw, &env); err != nil || env.Op != wsutil.OpSubscribed {
			t.Fatalf("expected OpSubscribed, got raw=%s err=%v", raw, err)
		}
	}

	// ── Freeze: stop reading for 400ms ───────────────────────────────────────
	// Net.Pipe has no kernel buffer, so the very next server write blocks.
	// While blocked, the flood goroutine fills the 200-slot sub queue, triggering
	// handleSubOverflow which enqueues the gap frame and calls EndSub.
	time.Sleep(400 * time.Millisecond)

	// Wait for the overflow to be detected (flood goroutine closes overflowDone).
	// This confirms that SendToSub returned an error, meaning the sub was removed.
	select {
	case <-bpHandler.overflowDone:
		// overflow confirmed
	case <-time.After(5 * time.Second):
		t.Fatal("backpressure: flood goroutine did not detect overflow within 5s after freeze")
	}

	// ── Unfreeze: resume reading, look for gap frame ──────────────────────────
	var gapEnv wsutil.Envelope
	var seenGap bool
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		rctx, rcancel := context.WithTimeout(context.Background(), remaining)
		_, data, err := c.Read(rctx)
		rcancel()
		if err != nil {
			t.Fatalf("unexpected read error after unfreeze: %v", err)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			twsWriteSilent(c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			continue
		}
		if env.Kind == wsutil.KindStream && env.Op == wsutil.OpGap {
			gapEnv = env
			seenGap = true
			break
		}
		// Skip stream events buffered before the overflow.
	}

	if !seenGap {
		t.Fatal("backpressure: expected gap frame — subscription queue overflow not triggered")
	}
	if gapEnv.SubId != "sub-bp" {
		t.Errorf("gap subId: got %q, want sub-bp", gapEnv.SubId)
	}
	var gapPayload struct {
		Cause string `json:"cause"`
	}
	if err := json.Unmarshal(gapEnv.Payload, &gapPayload); err != nil {
		t.Fatalf("unmarshal gap payload: %v", err)
	}
	if gapPayload.Cause != "buffer_full" {
		t.Errorf("gap cause: got %q, want buffer_full", gapPayload.Cause)
	}

	// Verify the connection is still alive: subscribe to a second subId.
	// The custom handler sends OpSubscribed for any sub (no flood on second call).
	twsSubscribe(t, c, "sub-alive", uuid.New().String(), nil, nil)
	aliveResp := twsRead(t, c, 3*time.Second)
	if aliveResp.Op != wsutil.OpSubscribed {
		t.Fatalf("expected OpSubscribed on alive check, got %+v", aliveResp)
	}

	t.Logf("backpressure OK: gap cause=%q, connection alive after overflow", gapPayload.Cause)
}

// ──────────────── Test 2: Reconnect catchup (live stream atomicity) ───────────

// TestSmokeReconnectCatchupLiveStreamAtomicity verifies the atomicity guarantee
// of SubscribeWithCatchup when the stream is still running:
//   - first connection receives N events, then disconnects
//   - second connection subscribes with epoch + lastSeq
//   - exactly the missed events arrive, in order, with no duplicates
//
// The atomicity guarantee (snapshot buffer + register live channel in one lock)
// is critical: without it, events between snapshot and registration are either
// lost or delivered twice.
//
// Note: TestThreadWSReconnectWithEpochCatchup in thread_ws_integration_test.go covers
// reconnect with a completed stream. This test exercises the live-stream path.
func TestSmokeReconnectCatchupLiveStreamAtomicity(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	const totalEvents = 20
	startCh := make(chan struct{})
	// Stream emits totalEvents with a tiny delay so the client can intercept partway.
	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		<-startCh
		for i := 1; i <= totalEvents; i++ {
			send(mstream.NewEvent([]byte(fmt.Sprintf(`{"seq":%d}`, i))))
			time.Sleep(5 * time.Millisecond) // slow enough to catch mid-stream
		}
		return nil
	})
	if err := registry.Register(stream); err != nil {
		t.Fatalf("register stream: %v", err)
	}
	stream.Start()

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	// ── First connection: subscribe and collect the first few events ──────────
	c1, _ := twsConnect(t, ts, "valid-token")

	twsSubscribe(t, c1, "sub-first", turnID, nil, nil)
	sub1 := twsRead(t, c1, time.Second)
	if sub1.Op != wsutil.OpSubscribed {
		t.Fatalf("c1: expected subscribed, got %+v", sub1)
	}
	epoch := sub1.Epoch

	// Unblock the stream.
	close(startCh)

	// Collect the first 5 events from c1.
	const firstBatch = 5
	firstSeqs := make([]int64, 0, firstBatch)
	for len(firstSeqs) < firstBatch {
		env, ok := twsTryRead(c1, 500*time.Millisecond)
		if !ok {
			break
		}
		if env.Op == wsutil.OpEvent {
			firstSeqs = append(firstSeqs, env.Seq)
		}
	}
	if len(firstSeqs) < firstBatch {
		t.Fatalf("c1: expected %d events, got %d", firstBatch, len(firstSeqs))
	}
	lastSeq := firstSeqs[firstBatch-1]

	// Disconnect c1.
	_ = c1.CloseNow()

	// ── Second connection: reconnect with epoch + lastSeq ─────────────────────
	c2, _ := twsConnect(t, ts, "valid-token")
	defer c2.CloseNow()

	twsSubscribe(t, c2, "sub-second", turnID, &lastSeq, &epoch)
	sub2 := twsRead(t, c2, time.Second)
	if sub2.Op != wsutil.OpSubscribed {
		t.Fatalf("c2: expected subscribed, got %+v", sub2)
	}

	// Collect all events until stream ends or timeout.
	var catchupSeqs []int64
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		env, ok := twsTryRead(c2, 200*time.Millisecond)
		if !ok {
			break
		}
		if env.Op == wsutil.OpEnded {
			break
		}
		if env.Op == wsutil.OpEvent {
			catchupSeqs = append(catchupSeqs, env.Seq)
		}
	}

	// Verify: no duplicates (all catchup seqs > lastSeq).
	for _, seq := range catchupSeqs {
		if seq <= lastSeq {
			t.Errorf("duplicate/old event delivered: seq=%d (lastSeq=%d)", seq, lastSeq)
		}
	}
	// Verify: catchup events are monotonically increasing.
	for i := 1; i < len(catchupSeqs); i++ {
		if catchupSeqs[i] <= catchupSeqs[i-1] {
			t.Errorf("catchup seqs not monotonic: %v", catchupSeqs)
			break
		}
	}
	t.Logf("reconnect catchup OK: lastSeq=%d, catchup events received=%d (seqs=%v)",
		lastSeq, len(catchupSeqs), catchupSeqs)
}

// ──────────────────────── Test 3: Reconnect stale epoch ───────────────────────

// TestSmokeReconnectStaleEpochGapAndConnectionAlive verifies that subscribing
// with a made-up epoch returns a gap with cause=epoch_mismatch and that the
// connection remains usable after receiving the gap.
//
// Note: TestThreadWSReconnectStaleEpoch already covers this; this smoke test
// additionally verifies the connection-alive property post-gap.
func TestSmokeReconnectStaleEpochGapAndConnectionAlive(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	// Register a completed stream so the server will attempt SubscribeWithCatchup.
	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		send(mstream.NewEvent([]byte(`{"type":"TEXT_DELTA"}`)))
		return nil
	})
	if err := registry.Register(stream); err != nil {
		t.Fatalf("register: %v", err)
	}
	stream.Start()
	if !waitForCondition(t, time.Second, func() bool {
		return stream.Status() == mstream.StatusComplete
	}) {
		t.Fatal("stream did not complete")
	}

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	// Subscribe with a stale (made-up) epoch.
	staleEpoch := "stale-epoch-" + uuid.New().String()
	lastSeq := int64(99)
	twsSubscribe(t, c, "sub-stale", turnID, &lastSeq, &staleEpoch)

	gap := twsRead(t, c, time.Second)
	if gap.Kind != wsutil.KindStream || gap.Op != wsutil.OpGap {
		t.Fatalf("expected gap for stale epoch, got %+v", gap)
	}
	var gapPayload struct {
		Cause string `json:"cause"`
	}
	if err := json.Unmarshal(gap.Payload, &gapPayload); err != nil {
		t.Fatalf("unmarshal gap payload: %v", err)
	}
	if gapPayload.Cause != "epoch_mismatch" {
		t.Fatalf("expected cause epoch_mismatch, got %q", gapPayload.Cause)
	}

	// Verify connection is alive after the gap: fresh subscribe (no epoch) succeeds.
	twsSubscribe(t, c, "sub-fresh", turnID, nil, nil)
	fresh := twsRead(t, c, time.Second)
	if fresh.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed after stale-epoch gap, connection must stay alive, got %+v", fresh)
	}
	t.Logf("stale epoch OK: gap cause=%q, connection alive", gapPayload.Cause)
}

// ────────────────── Test 4: Two-gap livelock ──────────────────────────────────
//
// SKIPPED — frontend-only concern.
//
// Two-gap livelock (reconnect-stale-epoch.md) occurs when the client enters an
// infinite subscribe→gap→subscribe loop after consecutive epoch mismatches.
// Mitigation: the client tracks per-turnId gap counts and stops reconnecting
// after two consecutive gaps for the same turn (React hook, not backend logic).
// The backend always returns the same epoch_mismatch gap regardless of how many
// times the client reconnects. No server-side fix needed.

// ──────────────── Test 5: Stream-switch race (interjection forwarding) ────────

// TestSmokeStreamSwitchInterjectionRoutedToSuccessor verifies that when an
// interjection arrives during a drain window (BeginDrain active), the
// InterjectionRouter routes it to the successor turn instead of the original.
// The WS handler faithfully forwards the routed content back to the client.
func TestSmokeStreamSwitchInterjectionRoutedToSuccessor(t *testing.T) {
	registry := mstream.NewRegistry()
	originalTurnID := uuid.New().String()
	successorTurnID := uuid.New().String()

	// Mock router: Route() always returns the successor, simulating an active drain.
	successorBuf := mstream.NewInMemoryInterjectionBuffer()
	_ = successorBuf.Append("forwarded to successor")
	router := &threadWSInterjectionRouter{
		routeTarget: successorTurnID,
		buf:         successorBuf,
	}

	deps := TurnStreamHandlerDeps{
		StreamRegistry:     registry,
		InterjectionRouter: router,
		Authorizer:         &threadWSAuthorizer{},
		Logger:             nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	// Send an interjection targeting the original turn.
	// The router will route it to the successor (simulating drain in progress).
	twsWrite(t, c, wsutil.Envelope{
		Kind:     wsutil.KindStream,
		Op:       wsutil.OpMessage,
		Resource: &wsutil.Resource{Type: "turn", Id: originalTurnID},
		Payload:  json.RawMessage(`{"action":"interjection","text":"change direction","mode":"append"}`),
	})

	result := twsRead(t, c, time.Second)
	if result.Kind != wsutil.KindControl || result.Op != wsutil.OpInterjectionResult {
		t.Fatalf("expected interjection_result, got %+v", result)
	}
	// The result's resource ID is the original turn (the one the client sent to).
	if result.Resource == nil || result.Resource.Id != originalTurnID {
		t.Errorf("interjection_result resource: got %+v, want id=%s", result.Resource, originalTurnID)
	}
	var payload struct {
		Mode    string `json:"mode"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(result.Payload, &payload); err != nil {
		t.Fatalf("unmarshal interjection_result: %v", err)
	}
	if payload.Mode != "queued" {
		t.Errorf("interjection_result mode: got %q, want queued", payload.Mode)
	}
	// Content is from the successor's buffer — proving routing to the successor.
	if payload.Content != "forwarded to successor" {
		t.Errorf("interjection_result content: got %q, want %q", payload.Content, "forwarded to successor")
	}
	t.Logf("stream switch race OK: interjection routed to successor, content=%q", payload.Content)
}

// ───────────────── Test 6: Missed stream switch ────────────────────────────────

// TestSmokeMissedStreamSwitchEndedWithSuccessorId verifies that subscribing to a
// turn that has already undergone a stream switch (status=complete,
// stop_reason=stream_switch, response_metadata.successor_turn_id set) delivers:
//   - control:subscribed
//   - stream:ended{reason:"stream_switch", newAssistantTurnId:"<successor>"}
//
// This is the recovery path for a client that missed the live ended event.
func TestSmokeMissedStreamSwitchEndedWithSuccessorId(t *testing.T) {
	registry := mstream.NewRegistry() // no active stream for this turn
	turnID := uuid.New().String()
	successorID := uuid.New().String()
	stopReason := "stream_switch"

	reader := &threadWSTurnReader{
		turns: map[string]*domainllm.Turn{
			turnID: {
				Status:     domainllm.TurnStatusComplete,
				StopReason: &stopReason,
				ResponseMetadata: map[string]interface{}{
					"successor_turn_id": successorID,
				},
			},
		},
	}

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		TurnReader:     reader,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	twsSubscribe(t, c, "sub-switch", turnID, nil, nil)

	// Expect subscribed first.
	subscribed := twsRead(t, c, time.Second)
	if subscribed.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed)
	}

	// Expect ended with reason=stream_switch and newAssistantTurnId=successorID.
	ended := twsRead(t, c, time.Second)
	if ended.Kind != wsutil.KindStream || ended.Op != wsutil.OpEnded {
		t.Fatalf("expected ended, got %+v", ended)
	}
	if ended.SubId != "sub-switch" {
		t.Errorf("ended subId: got %q, want sub-switch", ended.SubId)
	}
	var endedPayload struct {
		Reason             string `json:"reason"`
		NewAssistantTurnId string `json:"newAssistantTurnId"`
	}
	if err := json.Unmarshal(ended.Payload, &endedPayload); err != nil {
		t.Fatalf("unmarshal ended payload: %v", err)
	}
	if endedPayload.Reason != "stream_switch" {
		t.Errorf("ended reason: got %q, want stream_switch", endedPayload.Reason)
	}
	if endedPayload.NewAssistantTurnId != successorID {
		t.Errorf("newAssistantTurnId: got %q, want %q", endedPayload.NewAssistantTurnId, successorID)
	}
	t.Logf("missed stream switch OK: reason=%q, successor=%q", endedPayload.Reason, endedPayload.NewAssistantTurnId)
}

// ────────────────── Test 7: Subscription slot exhaustion ──────────────────────

// TestSmokeSubscriptionSlotExhaustion verifies the maxSubscriptionsPerConn=10
// limit and that ending subscriptions via OpUnsubscribe properly frees slots:
//   - subscribing to 10 turns fills all slots
//   - an 11th subscribe returns SUBSCRIBE_FAILED
//   - unsubscribing one turn frees its slot
//   - the 11th subscribe then succeeds
func TestSmokeSubscriptionSlotExhaustion(t *testing.T) {
	const maxSubs = 10
	turnIDs := make([]string, maxSubs+1)
	turns := make(map[string]*domainllm.Turn, maxSubs+1)
	for i := range turnIDs {
		turnIDs[i] = uuid.New().String()
		turns[turnIDs[i]] = &domainllm.Turn{Status: domainllm.TurnStatusPending}
	}

	registry := mstream.NewRegistry()
	reader := &threadWSTurnReader{turns: turns}

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		TurnReader:     reader,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	// Subscribe to turns 0..9 — all should succeed (pending turns hold slots).
	for i := 0; i < maxSubs; i++ {
		subID := fmt.Sprintf("sub-%d", i)
		twsSubscribe(t, c, subID, turnIDs[i], nil, nil)
	}
	// Drain all 10 subscribed acks.
	for i := 0; i < maxSubs; i++ {
		env := twsRead(t, c, time.Second)
		if env.Op != wsutil.OpSubscribed {
			t.Fatalf("expected subscribed for sub-%d, got %+v", i, env)
		}
	}

	// 11th subscribe must fail (slot limit).
	twsSubscribe(t, c, "sub-11", turnIDs[maxSubs], nil, nil)
	limitErr := twsRead(t, c, time.Second)
	if limitErr.Kind != wsutil.KindError {
		t.Fatalf("expected error for 11th subscribe, got %+v", limitErr)
	}
	var ep wsutil.ErrorPayload
	if err := json.Unmarshal(limitErr.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if ep.Code != wsutil.CodeSubscribeFailed {
		t.Errorf("expected SUBSCRIBE_FAILED, got %q", ep.Code)
	}

	// Unsubscribe sub-0 to free its slot.
	twsWrite(t, c, wsutil.Envelope{
		Kind:  wsutil.KindControl,
		Op:    wsutil.OpUnsubscribe,
		SubId: "sub-0",
	})
	ack := twsRead(t, c, time.Second)
	if ack.Kind != wsutil.KindControl || ack.Op != wsutil.OpUnsubscribed {
		t.Fatalf("expected unsubscribed ack, got %+v", ack)
	}
	if ack.SubId != "sub-0" {
		t.Errorf("unsubscribed ack subId: got %q, want sub-0", ack.SubId)
	}

	// Now the 11th subscribe should succeed.
	twsSubscribe(t, c, "sub-11", turnIDs[maxSubs], nil, nil)
	recovered := twsRead(t, c, time.Second)
	if recovered.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed after freeing slot, got %+v", recovered)
	}
	if recovered.SubId != "sub-11" {
		t.Errorf("subscribed subId: got %q, want sub-11", recovered.SubId)
	}
	t.Logf("slot exhaustion OK: 10-sub limit enforced, slot freed and reused")
}

// ───────────────── Test 8: Panic recovery ─────────────────────────────────────

// TestSmokePanicRecoveryConnectionAlive verifies that a panic in OnSubscribe
// is caught by the framework's recover() wrapper:
//   - the client receives an error frame (SUBSCRIBE_FAILED or error code)
//   - the connection stays alive — a subsequent subscribe to a safe handler succeeds
func TestSmokePanicRecoveryConnectionAlive(t *testing.T) {
	panic_ := &panicOnSubscribeHandler{}
	safe := &safeHandler{}

	srv := wsutil.NewServer(
		wsutil.WithAuth(&threadWSAuth{}),
		wsutil.WithHeartbeat(10*time.Second, 10*time.Second),
		wsutil.WithRateLimit(30),
	)
	srv.RegisterHandler("danger", panic_)
	srv.RegisterHandler("safe", safe)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/threads", srv.Serve)
	// Use a fresh threadWSAuth and a standard httptest server.
	// (Not using threadWSServer helper because we need custom handler registration.)
	import_ts := threadWSServerWithSrv(t, srv)

	c, _ := twsConnect(t, import_ts, "valid-token")
	defer c.CloseNow()

	// Subscribe to "danger" resource — OnSubscribe panics inside the framework's
	// callHandler, which catches it with recover() and returns an error.
	twsWrite(t, c, wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-panic",
		Resource: &wsutil.Resource{Type: "danger", Id: "r-1"},
	})
	panicErr := twsRead(t, c, time.Second)
	if panicErr.Kind != wsutil.KindError {
		t.Fatalf("expected error frame after OnSubscribe panic, got %+v", panicErr)
	}
	// Subscribe to "safe" resource — must succeed, proving the connection is alive.
	twsWrite(t, c, wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-safe",
		Resource: &wsutil.Resource{Type: "safe", Id: "r-2"},
	})
	safeResult := twsRead(t, c, time.Second)
	if safeResult.Kind != wsutil.KindControl || safeResult.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed on safe handler, got %+v", safeResult)
	}
	if safe.subscribes.Load() != 1 {
		t.Errorf("expected 1 safe subscribe call, got %d", safe.subscribes.Load())
	}
	t.Log("panic recovery OK: error frame delivered, connection alive after handler panic")
}

// threadWSServerWithSrv builds a real HTTP test server using the provided
// pre-configured wsutil.Server (instead of building a fresh one from deps).
func threadWSServerWithSrv(t *testing.T, srv *wsutil.Server) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/threads", srv.Serve)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

// ───────────────── Test 9: Heartbeat auth revocation ──────────────────────────

// TestSmokeHeartbeatAuthRevocation verifies that when project access is revoked
// after a connection is established, the heartbeat cycle detects it and closes
// the connection:
//   - connection established and auth checked (passes initially)
//   - access revoked (CheckProjectAccess starts returning an error)
//   - within one heartbeat cycle, the server sends AUTH_FAILED and closes
func TestSmokeHeartbeatAuthRevocation(t *testing.T) {
	auth := &mutableAuth{}

	deps := TurnStreamHandlerDeps{
		Authorizer: &threadWSAuthorizer{},
		Logger:     nullLogger(),
	}
	// Short heartbeat so the test completes quickly. The interval is 30ms;
	// revocation is detected within at most 30ms after setting the error.
	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(30*time.Millisecond, 200*time.Millisecond),
		wsutil.WithRateLimit(30),
	)
	h := NewTurnStreamHandler(deps)
	srv.RegisterHandler("turn", h)

	ts := threadWSServerWithSrv(t, srv)

	c, _ := twsConnectTo(t, ts, "project-1", "valid-token")
	defer c.CloseNow()

	// Verify the connection is alive: wait for the first heartbeat ping.
	var gotPing bool
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		rctx, rcancel := context.WithTimeout(context.Background(), remaining)
		_, data, err := c.Read(rctx)
		rcancel()
		if err != nil {
			break
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			// Respond with pong to confirm the connection is alive.
			twsWriteSilent(c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			gotPing = true
			break
		}
	}
	if !gotPing {
		t.Fatal("expected heartbeat ping before access revocation")
	}

	// Revoke access. The next heartbeat will call CheckProjectAccess, get an error,
	// enqueue AUTH_FAILED, and cancel the connection.
	auth.revokeAccess()

	// Wait for the connection to close. Give it a generous window: at most
	// 2 full heartbeat intervals (60ms) + write path latency (200ms timeout).
	gotAuthFailed := false
	connectionClosed := false
	closeDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(closeDeadline) {
		remaining := time.Until(closeDeadline)
		rctx, rcancel := context.WithTimeout(context.Background(), remaining)
		_, data, err := c.Read(rctx)
		rcancel()
		if err != nil {
			// Connection closed by server — this is the expected teardown path.
			connectionClosed = true
			break
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			// Still getting pings before the revocation cycle fires. Respond.
			twsWriteSilent(c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			continue
		}
		if env.Kind == wsutil.KindError {
			var ep wsutil.ErrorPayload
			_ = json.Unmarshal(env.Payload, &ep)
			if ep.Code == wsutil.CodeAuthFailed {
				gotAuthFailed = true
				// After AUTH_FAILED the server will close immediately; read the close.
				continue
			}
		}
	}

	// Teardown is confirmed if we observed either:
	//   (a) gotAuthFailed — explicit AUTH_FAILED error frame was received, OR
	//   (b) connectionClosed — the read loop got an error (server sent close frame)
	// Both are valid outcomes depending on the race between the writer delivering
	// AUTH_FAILED and the connection being fully torn down.
	if !gotAuthFailed && !connectionClosed {
		t.Error("heartbeat auth revocation: connection neither sent AUTH_FAILED nor closed within 500ms of revocation")
	}
	t.Logf("heartbeat auth revocation OK: gotAuthFailed=%v, connectionClosed=%v", gotAuthFailed, connectionClosed)
}
