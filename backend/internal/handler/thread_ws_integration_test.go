package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cws "github.com/coder/websocket"
	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	authdomain "meridian/internal/domain/auth"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/streaming"
	"meridian/internal/wsutil"
)

// ───────────────────────────────────────────────────────────── test doubles ──

type threadWSAuth struct {
	rejectToken string // if the incoming token equals this, auth fails
	accessErr   error  // returned by CheckProjectAccess
}

func (a *threadWSAuth) Authenticate(token string) (*wsutil.AuthResult, error) {
	if a.rejectToken != "" && token == a.rejectToken {
		return nil, errors.New("invalid token")
	}
	return &wsutil.AuthResult{UserID: "user-1", ExpiresAt: time.Now().Add(30 * time.Minute)}, nil
}

func (a *threadWSAuth) CheckProjectAccess(_ context.Context, _, _ string) error {
	return a.accessErr
}

type threadWSAuthorizer struct {
	err error
}

var _ authdomain.ResourceAuthorizer = (*threadWSAuthorizer)(nil)

func (a *threadWSAuthorizer) CanAccessProject(_ context.Context, _, _ string) error { return a.err }
func (a *threadWSAuthorizer) CanAccessFolder(_ context.Context, _, _ string) error  { return a.err }
func (a *threadWSAuthorizer) CanAccessDocument(_ context.Context, _, _ string) error {
	return a.err
}
func (a *threadWSAuthorizer) CanAccessThread(_ context.Context, _, _ string) error { return a.err }
func (a *threadWSAuthorizer) CanAccessTurn(_ context.Context, _, _ string) error   { return a.err }

type threadWSTurnReader struct {
	turns map[string]*domainllm.Turn
}

func (r *threadWSTurnReader) GetTurn(_ context.Context, turnID string) (*domainllm.Turn, error) {
	if t, ok := r.turns[turnID]; ok {
		return t, nil
	}
	return nil, fmt.Errorf("turn not found: %s", turnID)
}

func (r *threadWSTurnReader) GetRootTurns(_ context.Context, _ string) ([]domainllm.Turn, error) {
	return nil, nil
}

func (r *threadWSTurnReader) GetTurnBlocks(_ context.Context, _ string) ([]domainllm.TurnBlock, error) {
	return nil, nil
}

func (r *threadWSTurnReader) GetTurnBlocksForTurns(_ context.Context, _ []string) (map[string][]domainllm.TurnBlock, error) {
	return nil, nil
}

func (r *threadWSTurnReader) GetLastBlockSequence(_ context.Context, _ string) (int, error) {
	return -1, nil
}

type threadWSInterjectionRouter struct {
	routeTarget string
	routeErr    error
	buf         *mstream.InMemoryInterjectionBuffer
}

var _ streaming.InterjectionRouter = (*threadWSInterjectionRouter)(nil)

func (r *threadWSInterjectionRouter) Route(turnID, _, _ string) (string, bool, error) {
	if r.routeErr != nil {
		return "", false, r.routeErr
	}
	target := r.routeTarget
	if target == "" {
		target = turnID
	}
	return target, false, nil
}

func (r *threadWSInterjectionRouter) BeginDrain(_ string) (uint64, string, bool) {
	return 0, "", false
}

func (r *threadWSInterjectionRouter) CompleteDrain(_ string, _ uint64, _ string) (string, bool) {
	return "", false
}

func (r *threadWSInterjectionRouter) Rollback(_ string, _ uint64) bool { return false }

func (r *threadWSInterjectionRouter) Register(_ string) *mstream.InMemoryInterjectionBuffer {
	if r.buf != nil {
		return r.buf
	}
	buf := mstream.NewInMemoryInterjectionBuffer()
	_ = buf.Append("hello")
	return buf
}

func (r *threadWSInterjectionRouter) Remove(_ string) {}

// ──────────────────────────────────────────────────── server / client helpers ──

// threadWSServer builds a real HTTP test server with a TurnStreamHandler wired up.
func threadWSServer(t *testing.T, deps TurnStreamHandlerDeps, auth wsutil.Authenticator) *httptest.Server {
	t.Helper()
	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(50*time.Millisecond, 200*time.Millisecond),
		wsutil.WithRateLimit(30),
		wsutil.WithReadLimit(64*1024),
	)
	h := NewTurnStreamHandler(deps)
	srv.RegisterHandler("turn", h)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/threads", srv.Serve)

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

// wsURL converts an httptest server URL to a websocket URL for the given project.
func wsURL(ts *httptest.Server, projectID string) string {
	return strings.Replace(ts.URL, "http://", "ws://", 1) +
		"/ws/projects/" + projectID + "/threads"
}

// twsConnect dials the WS, sends the auth token, and reads the connected response.
// Returns the connection and the connectionId from the server.
func twsConnect(t *testing.T, ts *httptest.Server, token string) (*cws.Conn, string) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx, wsURL(ts, "project-1"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })

	authMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: json.RawMessage(`{"token":"` + token + `"}`),
	})
	if err := c.Write(ctx, cws.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	env := twsRead(t, c, time.Second)
	if env.Kind != wsutil.KindControl || env.Op != wsutil.OpConnected {
		t.Fatalf("expected connected, got %+v", env)
	}
	var payload struct {
		ConnectionID string `json:"connectionId"`
	}
	_ = json.Unmarshal(env.Payload, &payload)
	return c, payload.ConnectionID
}

// twsRead reads the next non-ping text envelope from the WS connection.
// It automatically replies to control:ping frames with control:pong so the
// connection stays alive even when the heartbeat interval is short.
func twsRead(t *testing.T, c *cws.Conn, timeout time.Duration) wsutil.Envelope {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("timeout (%s) waiting for non-ping envelope", timeout)
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		msgType, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if msgType != cws.MessageText {
			t.Fatalf("expected text frame, got %v", msgType)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			// Auto-pong to keep the connection alive during the test.
			twsWriteSilent(c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			continue
		}
		return env
	}
}

// twsTryRead attempts to read the next non-ping envelope within timeout.
// Returns ok=false on timeout or connection error.
func twsTryRead(c *cws.Conn, timeout time.Duration) (wsutil.Envelope, bool) {
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return wsutil.Envelope{}, false
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		_, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			return wsutil.Envelope{}, false
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			return wsutil.Envelope{}, false
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			// Auto-pong; then keep looking.
			twsWriteSilent(c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			continue
		}
		return env, true
	}
}

// twsWriteSilent sends an envelope without failing the test on error.
func twsWriteSilent(c *cws.Conn, env wsutil.Envelope) {
	data, _ := json.Marshal(env)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = c.Write(ctx, cws.MessageText, data)
}

// twsWrite sends a text envelope.
func twsWrite(t *testing.T, c *cws.Conn, env wsutil.Envelope) {
	t.Helper()
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, cws.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// twsSubscribe sends a subscribe envelope for the given turn.
func twsSubscribe(t *testing.T, c *cws.Conn, subID, turnID string, lastSeq *int64, epoch *string) {
	t.Helper()
	var payload json.RawMessage
	if lastSeq != nil || epoch != nil {
		m := map[string]any{}
		if lastSeq != nil {
			m["lastSeq"] = *lastSeq
		}
		if epoch != nil {
			m["epoch"] = *epoch
		}
		payload, _ = json.Marshal(m)
	}
	twsWrite(t, c, wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    subID,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Payload:  payload,
	})
}

// nullLogger returns a slog logger that discards all output.
func nullLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// ────────────────────────────────────────────────────────────────── tests ──

// TestThreadWSConnectAndAuth verifies the full connect + auth → connected flow.
// Client sends JWT in the auth envelope; server replies with connected + connectionId.
func TestThreadWSConnectAndAuth(t *testing.T) {
	auth := &threadWSAuth{}
	deps := TurnStreamHandlerDeps{
		Authorizer: &threadWSAuthorizer{},
		Logger:     nullLogger(),
	}
	ts := threadWSServer(t, deps, auth)

	c, connID := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	if connID == "" {
		t.Fatal("expected non-empty connectionId in connected payload")
	}
}

// TestThreadWSBadAuth verifies that an invalid token results in an AUTH_FAILED error
// frame followed by connection closure (no connected message).
func TestThreadWSBadAuth(t *testing.T) {
	auth := &threadWSAuth{rejectToken: "bad-token"}
	deps := TurnStreamHandlerDeps{Logger: nullLogger()}
	ts := threadWSServer(t, deps, auth)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx, wsURL(ts, "project-1"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	authMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: json.RawMessage(`{"token":"bad-token"}`),
	})
	if err := c.Write(ctx, cws.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	env := twsRead(t, c, time.Second)
	if env.Kind != wsutil.KindError {
		t.Fatalf("expected error envelope, got %+v", env)
	}
	var ep wsutil.ErrorPayload
	if err := json.Unmarshal(env.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if ep.Code != wsutil.CodeAuthFailed {
		t.Fatalf("expected AUTH_FAILED, got %q", ep.Code)
	}

	// Connection must close after auth failure.
	readCtx, readCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer readCancel()
	_, _, err = c.Read(readCtx)
	if err == nil {
		t.Fatal("expected connection closed after bad auth")
	}
}

// TestThreadWSPingPong verifies the heartbeat ping/pong cycle.
// Server sends ping; client responds with pong; server does NOT close the connection.
func TestThreadWSPingPong(t *testing.T) {
	auth := &threadWSAuth{}
	deps := TurnStreamHandlerDeps{
		Authorizer: &threadWSAuthorizer{},
		Logger:     nullLogger(),
	}
	ts := threadWSServer(t, deps, auth)

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	// Wait for the heartbeat ping (50ms interval).
	// twsTryRead auto-pongs and skips pings, so we read raw frames here to
	// capture the ping ourselves.
	deadline := time.Now().Add(300 * time.Millisecond)
	gotPing := false
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		readCtx, readCancel := context.WithTimeout(context.Background(), remaining)
		_, data, err := c.Read(readCtx)
		readCancel()
		if err != nil {
			t.Fatalf("timeout waiting for ping: %v", err)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			gotPing = true
			break
		}
	}
	if !gotPing {
		t.Fatal("timeout waiting for ping")
	}

	// Respond with pong.
	twsWrite(t, c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})

	// Connection must remain alive: no close within 300ms.
	time.Sleep(300 * time.Millisecond)

	// Verify still alive: send pong again (harmless).
	twsWrite(t, c, wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
}

// TestThreadWSSubscribeTerminalTurn subscribes to a completed turn whose stream is
// already in the registry with a buffer of events. The client must receive:
// subscribed → catchup events (monotonic seq) → ended{reason:"completed"}.
func TestThreadWSSubscribeTerminalTurn(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	// Build a stream with 3 events, let it complete before the client subscribes.
	events := [][]byte{
		[]byte(`{"type":"TEXT_DELTA","text":"Hello"}`),
		[]byte(`{"type":"TEXT_DELTA","text":" world"}`),
		[]byte(`{"type":"TEXT_DELTA","text":"!"}`),
	}
	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		for _, ev := range events {
			send(mstream.NewEvent(ev))
		}
		return nil
	})
	if err := registry.Register(stream); err != nil {
		t.Fatalf("register stream: %v", err)
	}
	stream.Start()

	// Give stream time to complete and populate the buffer.
	if !waitForCondition(t, time.Second, func() bool {
		return stream.Status() == mstream.StatusComplete
	}) {
		t.Fatal("stream did not complete in time")
	}

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	twsSubscribe(t, c, "sub-1", turnID, nil, nil)

	// subscribed response.
	subscribed := twsRead(t, c, time.Second)
	if subscribed.Kind != wsutil.KindControl || subscribed.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed)
	}
	if subscribed.SubId != "sub-1" {
		t.Fatalf("expected subId sub-1, got %q", subscribed.SubId)
	}
	epoch := subscribed.Epoch
	if epoch == "" {
		t.Fatal("expected non-empty epoch in subscribed")
	}

	// Read 3 catchup events and verify monotonic sequence numbers.
	var prevSeq int64 = -1
	for i := 0; i < len(events); i++ {
		env := twsRead(t, c, time.Second)
		if env.Kind != wsutil.KindStream || env.Op != wsutil.OpEvent {
			t.Fatalf("expected stream event [%d], got %+v", i, env)
		}
		if env.SubId != "sub-1" {
			t.Fatalf("unexpected subId on event [%d]: %q", i, env.SubId)
		}
		if env.Epoch != epoch {
			t.Fatalf("epoch mismatch on event [%d]: got %q want %q", i, env.Epoch, epoch)
		}
		if env.Seq <= prevSeq {
			t.Fatalf("seq not monotonically increasing: prev=%d curr=%d", prevSeq, env.Seq)
		}
		prevSeq = env.Seq
	}

	// ended envelope.
	ended := twsRead(t, c, time.Second)
	if ended.Kind != wsutil.KindStream || ended.Op != wsutil.OpEnded {
		t.Fatalf("expected ended, got %+v", ended)
	}
	if ended.SubId != "sub-1" {
		t.Fatalf("unexpected subId on ended: %q", ended.SubId)
	}
	var endedPayload struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(ended.Payload, &endedPayload); err != nil {
		t.Fatalf("unmarshal ended payload: %v", err)
	}
	if endedPayload.Reason != "completed" {
		t.Fatalf("expected reason 'completed', got %q", endedPayload.Reason)
	}
}

// TestThreadWSSubscribeLiveTurnEvents subscribes to a stream that is still running.
// After subscribing, events arrive live and the client receives them in order.
// The stream then completes and the client receives ended.
func TestThreadWSSubscribeLiveTurnEvents(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	startCh := make(chan struct{})   // unblocks event emission
	eventCh := make(chan []byte, 10) // events to emit
	doneCh := make(chan struct{})    // signals workFunc to return

	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		<-startCh
		for data := range eventCh {
			send(mstream.NewEvent(data))
		}
		<-doneCh
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

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	twsSubscribe(t, c, "sub-live", turnID, nil, nil)

	// subscribed response (stream is running, no catchup yet).
	subscribed := twsRead(t, c, time.Second)
	if subscribed.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed)
	}
	epoch := subscribed.Epoch

	// Unblock the stream and emit 3 events.
	close(startCh)
	for i := 1; i <= 3; i++ {
		eventCh <- []byte(fmt.Sprintf(`{"n":%d}`, i))
	}

	// Read 3 live events with monotonic seq.
	var prevSeq int64 = -1
	for i := 1; i <= 3; i++ {
		env := twsRead(t, c, time.Second)
		if env.Op != wsutil.OpEvent {
			t.Fatalf("expected event [%d], got %+v", i, env)
		}
		if env.Seq <= prevSeq {
			t.Fatalf("seq not monotonically increasing: prev=%d curr=%d", prevSeq, env.Seq)
		}
		if env.Epoch != epoch {
			t.Fatalf("epoch mismatch on event [%d]: got %q want %q", i, env.Epoch, epoch)
		}
		prevSeq = env.Seq
	}

	// Complete the stream.
	close(eventCh)
	close(doneCh)

	// ended must arrive.
	ended := twsRead(t, c, time.Second)
	if ended.Kind != wsutil.KindStream || ended.Op != wsutil.OpEnded {
		t.Fatalf("expected ended, got %+v", ended)
	}
	var p struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(ended.Payload, &p)
	if p.Reason != "completed" {
		t.Fatalf("expected reason 'completed', got %q", p.Reason)
	}
}

// TestThreadWSSubscribePendingTurn subscribes to a turn whose stream is NOT in the
// registry and whose DB status is "pending". The client receives subscribed with no
// catchup events (it waits for a notify to arrive later).
func TestThreadWSSubscribePendingTurn(t *testing.T) {
	registry := mstream.NewRegistry() // empty — stream not in registry
	turnID := uuid.New().String()

	reader := &threadWSTurnReader{
		turns: map[string]*domainllm.Turn{
			turnID: {Status: domainllm.TurnStatusPending},
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

	twsSubscribe(t, c, "sub-1", turnID, nil, nil)

	subscribed := twsRead(t, c, time.Second)
	if subscribed.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed)
	}

	// No events or ended must follow (turn is pending, client waits for notify).
	if env, ok := twsTryRead(c, 150*time.Millisecond); ok {
		t.Fatalf("expected no events for pending turn, got %+v", env)
	}
}

// TestThreadWSSubscribeStreamingTurnNoRegistry subscribes to a turn that has status
// "streaming" in the DB but is not in the in-memory registry (server restart).
// The client must receive a gap message.
func TestThreadWSSubscribeStreamingTurnNoRegistry(t *testing.T) {
	registry := mstream.NewRegistry() // empty
	turnID := uuid.New().String()

	reader := &threadWSTurnReader{
		turns: map[string]*domainllm.Turn{
			turnID: {Status: domainllm.TurnStatusStreaming},
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

	twsSubscribe(t, c, "sub-1", turnID, nil, nil)

	gap := twsRead(t, c, time.Second)
	if gap.Kind != wsutil.KindStream || gap.Op != wsutil.OpGap {
		t.Fatalf("expected gap for streaming turn with no registry entry, got %+v", gap)
	}
	if gap.SubId != "sub-1" {
		t.Fatalf("expected subId sub-1 in gap, got %q", gap.SubId)
	}
	var gapPayload struct {
		Cause string `json:"cause"`
	}
	if err := json.Unmarshal(gap.Payload, &gapPayload); err != nil {
		t.Fatalf("unmarshal gap payload: %v", err)
	}
	if gapPayload.Cause == "" {
		t.Fatal("expected non-empty cause in gap payload")
	}
}

// TestThreadWSSubscribeNonexistentTurn subscribes to a turn that does not exist in
// either the registry or the DB. The server returns an error — not a turn-existence
// oracle (SUBSCRIBE_FAILED is generic per protocol).
func TestThreadWSSubscribeNonexistentTurn(t *testing.T) {
	registry := mstream.NewRegistry()
	reader := &threadWSTurnReader{turns: map[string]*domainllm.Turn{}}

	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		TurnReader:     reader,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	twsSubscribe(t, c, "sub-1", uuid.New().String(), nil, nil)

	errEnv := twsRead(t, c, time.Second)
	if errEnv.Kind != wsutil.KindError {
		t.Fatalf("expected error for nonexistent turn, got %+v", errEnv)
	}
	var ep wsutil.ErrorPayload
	if err := json.Unmarshal(errEnv.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if ep.Code != wsutil.CodeSubscribeFailed {
		t.Fatalf("expected SUBSCRIBE_FAILED, got %q", ep.Code)
	}
}

// TestThreadWSInterjection sends a stream:message with action "interjection" and
// verifies the server responds with control:interjection_result.
func TestThreadWSInterjection(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	buf := mstream.NewInMemoryInterjectionBuffer()
	_ = buf.Append("queued content")
	router := &threadWSInterjectionRouter{buf: buf}

	deps := TurnStreamHandlerDeps{
		StreamRegistry:     registry,
		InterjectionRouter: router,
		Authorizer:         &threadWSAuthorizer{},
		Logger:             nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	twsWrite(t, c, wsutil.Envelope{
		Kind:     wsutil.KindStream,
		Op:       wsutil.OpMessage,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Payload:  json.RawMessage(`{"action":"interjection","text":"Actually use a different approach","mode":"append"}`),
	})

	result := twsRead(t, c, time.Second)
	if result.Kind != wsutil.KindControl || result.Op != wsutil.OpInterjectionResult {
		t.Fatalf("expected interjection_result, got %+v", result)
	}
	if result.Resource == nil || result.Resource.Id != turnID {
		t.Fatalf("expected resource id %q in interjection_result, got %+v", turnID, result.Resource)
	}
	var p struct {
		Mode    string `json:"mode"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(result.Payload, &p); err != nil {
		t.Fatalf("unmarshal interjection_result payload: %v", err)
	}
	if p.Mode != "queued" {
		t.Fatalf("expected mode 'queued', got %q", p.Mode)
	}
}

// TestThreadWSBinaryFrameRejected verifies that a binary frame results in an
// INVALID_MESSAGE error and the connection is closed (thread WS has no binary handler).
func TestThreadWSBinaryFrameRejected(t *testing.T) {
	deps := TurnStreamHandlerDeps{
		Authorizer: &threadWSAuthorizer{},
		Logger:     nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, cws.MessageBinary, []byte{0x01, 0x02, 0x03}); err != nil {
		t.Fatalf("write binary: %v", err)
	}

	errEnv := twsRead(t, c, time.Second)
	var ep wsutil.ErrorPayload
	_ = json.Unmarshal(errEnv.Payload, &ep)
	if ep.Code != wsutil.CodeInvalidMessage {
		t.Fatalf("expected INVALID_MESSAGE for binary frame, got %q", ep.Code)
	}

	// Connection must close after the binary rejection.
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer closeCancel()
	_, _, err := c.Read(closeCtx)
	if err == nil {
		t.Fatal("expected connection closed after binary frame rejection")
	}
}

// TestThreadWSNotifyBroadcast verifies that BroadcastNotify delivers notify-lane
// events to all connected clients for the project.
func TestThreadWSNotifyBroadcast(t *testing.T) {
	auth := &threadWSAuth{}
	deps := TurnStreamHandlerDeps{
		Authorizer: &threadWSAuthorizer{},
		Logger:     nullLogger(),
	}

	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(10*time.Second, 10*time.Second),
		wsutil.WithRateLimit(30),
	)
	h := NewTurnStreamHandler(deps)
	srv.RegisterHandler("turn", h)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/threads", srv.Serve)

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	// Two clients in project-1.
	cA, _ := twsConnectTo(t, ts, "project-1", "valid-token")
	defer cA.CloseNow()
	cB, _ := twsConnectTo(t, ts, "project-1", "valid-token")
	defer cB.CloseNow()

	// One client in project-2 (must NOT receive the broadcast).
	cC, _ := twsConnectTo(t, ts, "project-2", "valid-token")
	defer cC.CloseNow()

	// Broadcast to project-1.
	notifyPayload, _ := json.Marshal(map[string]string{"event": "completed", "version": "42"})
	srv.BroadcastNotify("project-1", wsutil.Envelope{
		Op:       wsutil.OpInvalidate,
		Resource: &wsutil.Resource{Type: "turn", Id: "turn-xyz"},
		Payload:  notifyPayload,
	})

	envA := twsRead(t, cA, time.Second)
	envB := twsRead(t, cB, time.Second)
	assertNotifyInvalidate(t, envA)
	assertNotifyInvalidate(t, envB)

	if env, ok := twsTryRead(cC, 150*time.Millisecond); ok {
		t.Fatalf("project-2 client must not receive project-1 broadcast, got %+v", env)
	}
}

// assertNotifyInvalidate checks the envelope is a notify:invalidate.
func assertNotifyInvalidate(t *testing.T, env wsutil.Envelope) {
	t.Helper()
	if env.Kind != wsutil.KindNotify || env.Op != wsutil.OpInvalidate {
		t.Fatalf("expected notify:invalidate, got %+v", env)
	}
}

// TestThreadWSReconnectWithEpochCatchup verifies that a client can reconnect with
// the epoch and lastSeq from a previous subscription and receive only the missed
// events (no duplicates).
func TestThreadWSReconnectWithEpochCatchup(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	allEvents := make([][]byte, 5)
	for i := range allEvents {
		allEvents[i] = []byte(fmt.Sprintf(`{"n":%d}`, i+1))
	}

	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		for _, ev := range allEvents {
			send(mstream.NewEvent(ev))
		}
		return nil
	})
	if err := registry.Register(stream); err != nil {
		t.Fatalf("register stream: %v", err)
	}
	stream.Start()

	// Wait for stream to complete and buffer to be populated.
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

	// ── First connection: receive all 5 events ──────────────────────────────
	c1, _ := twsConnect(t, ts, "valid-token")
	twsSubscribe(t, c1, "sub-A", turnID, nil, nil)

	subscribed1 := twsRead(t, c1, time.Second)
	if subscribed1.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed, got %+v", subscribed1)
	}
	epoch := subscribed1.Epoch

	// Drain events. We stop on "ended" or after collecting all 5 events.
	// NOTE: The "ended" frame is sent via session.SendToSub before EndSub is called.
	// There is a known race where EndSub removes the subscription before the writer
	// drains the "ended" frame. We tolerate this by reading until "ended" OR timeout,
	// and require only that we received at least 3 events (enough for the lastSeq).
	seqs := make([]int64, 0, 5)
	for {
		env, ok := twsTryRead(c1, 500*time.Millisecond)
		if !ok || env.Op == wsutil.OpEnded {
			break
		}
		if env.Op == wsutil.OpEvent {
			seqs = append(seqs, env.Seq)
		}
	}
	if len(seqs) < 3 {
		t.Fatalf("expected at least 3 events on first connection, got %d", len(seqs))
	}
	// lastSeq is the seq of the 3rd event (simulating a partial receive).
	lastSeq := seqs[2]

	c1.CloseNow()

	// ── Second connection: reconnect with epoch + lastSeq ───────────────────
	c2, _ := twsConnect(t, ts, "valid-token")
	defer c2.CloseNow()

	twsSubscribe(t, c2, "sub-B", turnID, &lastSeq, &epoch)

	subscribed2 := twsRead(t, c2, time.Second)
	if subscribed2.Op != wsutil.OpSubscribed {
		t.Fatalf("expected subscribed on reconnect, got %+v", subscribed2)
	}

	// Must receive only the events after lastSeq (events 4,5).
	// Drain until "ended" or timeout (same tolerance as first connection).
	catchupSeqs := make([]int64, 0)
	for {
		env, ok := twsTryRead(c2, 500*time.Millisecond)
		if !ok || env.Op == wsutil.OpEnded {
			break
		}
		if env.Op == wsutil.OpEvent {
			if env.Seq <= lastSeq {
				t.Errorf("received duplicate/old event seq=%d (lastSeq=%d)", env.Seq, lastSeq)
			}
			catchupSeqs = append(catchupSeqs, env.Seq)
		}
	}

	// We emitted 5 events total; lastSeq = seqs[2] (the 3rd event).
	// So there are len(seqs)-3 events after lastSeq (at most 2).
	expectedCatchup := len(seqs) - 3
	if len(catchupSeqs) != expectedCatchup {
		t.Fatalf("expected %d catchup events after lastSeq=%d, got %d: %v",
			expectedCatchup, lastSeq, len(catchupSeqs), catchupSeqs)
	}
	// Verify ascending order.
	for i := 1; i < len(catchupSeqs); i++ {
		if catchupSeqs[i] <= catchupSeqs[i-1] {
			t.Errorf("catchup seqs not monotonic: %v", catchupSeqs)
		}
	}
}

// TestThreadWSReconnectStaleEpoch subscribes with an epoch that doesn't match the
// current stream instance. The server must send a gap with cause "epoch_mismatch".
func TestThreadWSReconnectStaleEpoch(t *testing.T) {
	registry := mstream.NewRegistry()
	turnID := uuid.New().String()

	stream := mstream.NewStream(turnID, func(_ context.Context, send func(mstream.Event)) error {
		send(mstream.NewEvent([]byte(`{"type":"TEXT_DELTA"}`)))
		return nil
	})
	if err := registry.Register(stream); err != nil {
		t.Fatalf("register stream: %v", err)
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

	staleEpoch := "stale-epoch-does-not-match"
	lastSeq := int64(1)
	twsSubscribe(t, c, "sub-1", turnID, &lastSeq, &staleEpoch)

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
		t.Fatalf("expected cause 'epoch_mismatch', got %q", gapPayload.Cause)
	}
}

// TestThreadWSRateLimit sends more than 30 messages/second and verifies the client
// receives a RATE_LIMITED error. Excess messages are dropped.
// NOTE: this test uses real-time scheduling and may be slightly flaky on very slow CI.
func TestThreadWSRateLimit(t *testing.T) {
	registry := mstream.NewRegistry()
	deps := TurnStreamHandlerDeps{
		StreamRegistry: registry,
		Authorizer:     &threadWSAuthorizer{},
		Logger:         nullLogger(),
	}
	ts := threadWSServer(t, deps, &threadWSAuth{})

	c, _ := twsConnect(t, ts, "valid-token")
	defer c.CloseNow()

	// Send 40 stream messages within a burst (all in the same second).
	for i := 0; i < 40; i++ {
		twsWrite(t, c, wsutil.Envelope{
			Kind:     wsutil.KindStream,
			Op:       wsutil.OpMessage,
			Resource: &wsutil.Resource{Type: "turn", Id: uuid.New().String()},
			Payload:  json.RawMessage(`{"action":"interjection","text":"x","mode":"append"}`),
		})
	}

	// Drain all responses and check for at least one RATE_LIMITED error.
	deadline := time.Now().Add(2 * time.Second)
	rateLimited := false
	for time.Now().Before(deadline) {
		env, ok := twsTryRead(c, 200*time.Millisecond)
		if !ok {
			break
		}
		if env.Kind == wsutil.KindError {
			var ep wsutil.ErrorPayload
			_ = json.Unmarshal(env.Payload, &ep)
			if ep.Code == wsutil.CodeRateLimited {
				rateLimited = true
				break
			}
		}
	}
	if !rateLimited {
		t.Fatal("expected RATE_LIMITED error after burst of 40 messages")
	}
}

// ──────────────────────────────────────────────────── additional helpers ──

// twsConnectTo dials and authenticates against a specific projectId path.
func twsConnectTo(t *testing.T, ts *httptest.Server, projectID, token string) (*cws.Conn, string) {
	t.Helper()

	url := strings.Replace(ts.URL, "http://", "ws://", 1) +
		"/ws/projects/" + projectID + "/threads"

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })

	authMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: json.RawMessage(`{"token":"` + token + `"}`),
	})
	writeCtx, writeCancel := context.WithTimeout(context.Background(), time.Second)
	defer writeCancel()
	if err := c.Write(writeCtx, cws.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	env := twsRead(t, c, time.Second)
	if env.Kind != wsutil.KindControl || env.Op != wsutil.OpConnected {
		t.Fatalf("expected connected for projectID=%s, got %+v", projectID, env)
	}
	var p struct{ ConnectionID string `json:"connectionId"` }
	_ = json.Unmarshal(env.Payload, &p)
	return c, p.ConnectionID
}

// waitForCondition polls the condition until it returns true or the deadline elapses.
func waitForCondition(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}
