package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	cws "github.com/coder/websocket"

	"meridian/internal/wsutil"
)

// ──────────────────────────────── server / client helpers (doc WS) ─────────

// docWSServer builds a real HTTP test server with a DocNotifyHandler wired up.
// It also returns the underlying wsutil.Server so tests can call BroadcastNotify.
func docWSServer(t *testing.T) (*httptest.Server, *wsutil.Server) {
	t.Helper()

	auth := &threadWSAuth{} // same simple auth — valid for any token
	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(10*time.Second, 10*time.Second),
		wsutil.WithRateLimit(30),
	)
	h := NewDocNotifyHandler(nullLogger())
	srv.RegisterHandler("document", h)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/docs", srv.Serve)

	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, srv
}

// dwsURL converts the test server base URL to a doc WS URL.
func dwsURL(ts *httptest.Server, projectID string) string {
	return strings.Replace(ts.URL, "http://", "ws://", 1) +
		"/ws/projects/" + projectID + "/docs"
}

// dwsConnect dials, authenticates, and returns the connected connection.
func dwsConnect(t *testing.T, ts *httptest.Server, projectID string) *cws.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx, dwsURL(ts, projectID), nil)
	if err != nil {
		t.Fatalf("dial doc ws: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })

	authMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: json.RawMessage(`{"token":"valid-token"}`),
	})
	writeCtx, wCancel := context.WithTimeout(context.Background(), time.Second)
	defer wCancel()
	if err := c.Write(writeCtx, cws.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	env := dwsRead(t, c, time.Second)
	if env.Kind != wsutil.KindControl || env.Op != wsutil.OpConnected {
		t.Fatalf("expected connected, got %+v", env)
	}
	return c
}

// dwsRead reads the next non-ping text envelope from the doc WS.
// Auto-responds to control:ping frames with control:pong.
func dwsRead(t *testing.T, c *cws.Conn, timeout time.Duration) wsutil.Envelope {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("timeout (%s) waiting for doc WS envelope", timeout)
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		msgType, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read doc ws: %v", err)
		}
		if msgType != cws.MessageText {
			t.Fatalf("expected text frame, got %v", msgType)
		}
		var env wsutil.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env.Kind == wsutil.KindControl && env.Op == wsutil.OpPing {
			// Auto-pong to keep connection alive.
			pongData, _ := json.Marshal(wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			pongCtx, pongCancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Write(pongCtx, cws.MessageText, pongData)
			pongCancel()
			continue
		}
		return env
	}
}

// dwsTryRead attempts to read the next non-ping envelope within timeout.
// Returns ok=false on timeout or connection error.
func dwsTryRead(c *cws.Conn, timeout time.Duration) (wsutil.Envelope, bool) {
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
			// Auto-pong; keep looking.
			pongData, _ := json.Marshal(wsutil.Envelope{Kind: wsutil.KindControl, Op: wsutil.OpPong})
			pongCtx, pongCancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Write(pongCtx, cws.MessageText, pongData)
			pongCancel()
			continue
		}
		return env, true
	}
}

// ─────────────────────────────────────────────────────────────── tests ──

// TestDocWSConnectAndAuth verifies basic connect + auth flow for the doc WS.
// Client sends JWT; server replies with connected + connectionId.
func TestDocWSConnectAndAuth(t *testing.T) {
	ts, _ := docWSServer(t)

	c := dwsConnect(t, ts, "project-1")
	defer c.CloseNow()

	// Verify connection is alive by checking no unexpected frames arrive.
	if env, ok := dwsTryRead(c, 100*time.Millisecond); ok {
		t.Fatalf("expected no frames after connected, got %+v", env)
	}
}

// TestDocWSNotifyBroadcast verifies that BroadcastNotify delivers invalidation hints
// to all connected doc WS clients in the project.
func TestDocWSNotifyBroadcast(t *testing.T) {
	ts, srv := docWSServer(t)

	// Two clients in project-1.
	cA := dwsConnect(t, ts, "project-1")
	defer cA.CloseNow()
	cB := dwsConnect(t, ts, "project-1")
	defer cB.CloseNow()

	// One client in project-2 (must NOT receive the broadcast).
	cC := dwsConnect(t, ts, "project-2")
	defer cC.CloseNow()

	// Broadcast a proposal:created notification to project-1.
	notifier := NewDocNotifier(srv)
	notifier.NotifyProposal("project-1", "proposal-abc", "created", "doc-xyz")

	for _, tc := range []struct {
		name string
		conn *cws.Conn
		want bool
	}{
		{"clientA (p1)", cA, true},
		{"clientB (p1)", cB, true},
		{"clientC (p2)", cC, false},
	} {
		env, ok := dwsTryRead(tc.conn, 500*time.Millisecond)
		if tc.want && !ok {
			t.Fatalf("%s: expected notify, got nothing", tc.name)
		}
		if !tc.want && ok {
			t.Fatalf("%s: should not receive notify, got %+v", tc.name, env)
		}
		if tc.want && ok {
			if env.Kind != wsutil.KindNotify || env.Op != wsutil.OpInvalidate {
				t.Fatalf("%s: expected notify:invalidate, got %+v", tc.name, env)
			}
			if env.Resource == nil || env.Resource.Type != "proposal" {
				t.Fatalf("%s: expected resource type 'proposal', got %+v", tc.name, env.Resource)
			}
		}
	}
}

// TestDocWSNotifyDocumentUpdated verifies that a document:updated notification
// is delivered correctly with the right resource type and payload.
func TestDocWSNotifyDocumentUpdated(t *testing.T) {
	ts, srv := docWSServer(t)

	c := dwsConnect(t, ts, "project-1")
	defer c.CloseNow()

	notifier := NewDocNotifier(srv)
	notifier.NotifyDocument("project-1", "doc-123", "updated")

	env := dwsRead(t, c, time.Second)
	if env.Kind != wsutil.KindNotify || env.Op != wsutil.OpInvalidate {
		t.Fatalf("expected notify:invalidate, got %+v", env)
	}
	if env.Resource == nil || env.Resource.Type != "document" || env.Resource.Id != "doc-123" {
		t.Fatalf("expected resource document/doc-123, got %+v", env.Resource)
	}
	var payload struct {
		Event string `json:"event"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Event != "updated" {
		t.Fatalf("expected event 'updated', got %q", payload.Event)
	}
}

// TestDocWSNotifyProposalAccepted verifies proposal:accepted notification delivery.
func TestDocWSNotifyProposalAccepted(t *testing.T) {
	ts, srv := docWSServer(t)

	c := dwsConnect(t, ts, "project-1")
	defer c.CloseNow()

	notifier := NewDocNotifier(srv)
	notifier.NotifyProposal("project-1", "proposal-999", "accepted", "doc-456")

	env := dwsRead(t, c, time.Second)
	if env.Resource == nil || env.Resource.Type != "proposal" || env.Resource.Id != "proposal-999" {
		t.Fatalf("expected resource proposal/proposal-999, got %+v", env.Resource)
	}
	var payload struct {
		Event      string `json:"event"`
		DocumentID string `json:"documentId"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Event != "accepted" {
		t.Fatalf("expected event 'accepted', got %q", payload.Event)
	}
	if payload.DocumentID != "doc-456" {
		t.Fatalf("expected documentId 'doc-456', got %q", payload.DocumentID)
	}
}

// TestDocWSSubscribeAttemptReturnsNotSupported verifies that a subscribe request
// to the doc notify handler returns a NOT_SUPPORTED error (notify-only for now).
func TestDocWSSubscribeAttemptReturnsNotSupported(t *testing.T) {
	ts, _ := docWSServer(t)

	c := dwsConnect(t, ts, "project-1")
	defer c.CloseNow()

	// Send a subscribe for a document resource.
	subscribeMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribe,
		SubId:    "sub-1",
		Resource: &wsutil.Resource{Type: "document", Id: "doc-abc"},
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, cws.MessageText, subscribeMsg); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}

	errEnv := dwsRead(t, c, time.Second)
	if errEnv.Kind != wsutil.KindError {
		t.Fatalf("expected error for subscribe on doc notify handler, got %+v", errEnv)
	}
	var ep wsutil.ErrorPayload
	if err := json.Unmarshal(errEnv.Payload, &ep); err != nil {
		t.Fatalf("unmarshal error payload: %v", err)
	}
	if ep.Code != wsutil.CodeNotSupported {
		t.Fatalf("expected NOT_SUPPORTED, got %q", ep.Code)
	}
}

// TestDocWSMultipleClientsReceiveAllNotifyTypes exercises all three notify methods
// on a single connection to confirm correct payload shapes.
func TestDocWSMultipleClientsReceiveAllNotifyTypes(t *testing.T) {
	ts, srv := docWSServer(t)

	c := dwsConnect(t, ts, "project-1")
	defer c.CloseNow()

	notifier := NewDocNotifier(srv)

	// Emit three different notification types.
	notifier.NotifyProposal("project-1", "p-1", "created", "d-1")
	notifier.NotifyProposal("project-1", "p-2", "rejected", "d-2")
	notifier.NotifyDocumentError("project-1", "d-3", "CONFLICT", "concurrent edit conflict")

	// Read and categorise the three notifications.
	received := map[string]bool{}
	for i := 0; i < 3; i++ {
		env := dwsRead(t, c, time.Second)
		if env.Kind != wsutil.KindNotify {
			t.Fatalf("expected notify, got %+v", env)
		}
		var payload struct {
			Event string `json:"event"`
		}
		_ = json.Unmarshal(env.Payload, &payload)
		received[payload.Event] = true
	}

	for _, want := range []string{"created", "rejected", "error"} {
		if !received[want] {
			t.Errorf("expected notify with event=%q, not received (got: %v)", want, received)
		}
	}
}

// TestDocWSBadAuth verifies that an invalid token closes the doc WS immediately.
func TestDocWSBadAuth(t *testing.T) {
	auth := &threadWSAuth{rejectToken: "bad-token"}
	srv := wsutil.NewServer(
		wsutil.WithAuth(auth),
		wsutil.WithHeartbeat(10*time.Second, 10*time.Second),
	)
	srv.RegisterHandler("document", NewDocNotifyHandler(nullLogger()))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}/docs", srv.Serve)

	ts := httptest.NewServer(mux)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	c, _, err := cws.Dial(ctx, dwsURL(ts, "project-1"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()

	authMsg, _ := json.Marshal(wsutil.Envelope{
		Kind:    wsutil.KindControl,
		Op:      wsutil.OpAuth,
		Payload: json.RawMessage(`{"token":"bad-token"}`),
	})
	writeCtx, wCancel := context.WithTimeout(context.Background(), time.Second)
	defer wCancel()
	if err := c.Write(writeCtx, cws.MessageText, authMsg); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	env := dwsRead(t, c, time.Second)
	if env.Kind != wsutil.KindError {
		t.Fatalf("expected error frame on bad auth, got %+v", env)
	}

	// Connection must close.
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer closeCancel()
	_, _, err = c.Read(closeCtx)
	if err == nil {
		t.Fatal("expected connection closed after bad auth")
	}
}
