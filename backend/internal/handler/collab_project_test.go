package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/net/websocket"
	"meridian/internal/config"
	"meridian/internal/domain/models"
	collabModels "meridian/internal/domain/models/collab"
)

// --- test resolver with ResolveDocument support ---

type testProjectCollabResolver struct {
	mu         sync.RWMutex
	allowed    bool
	projectID  string // returned by ResolveDocument
	resolveErr error
	ownerErr   error
}

func (r *testProjectCollabResolver) ResolveDocument(_ context.Context, docID string) (*collabModels.CollabDocRef, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.resolveErr != nil {
		return nil, r.resolveErr
	}
	return &collabModels.CollabDocRef{
		DocumentID: docID,
		ProjectID:  r.projectID,
	}, nil
}

func (r *testProjectCollabResolver) VerifyOwnership(_ context.Context, _ string, _ string) (bool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.ownerErr != nil {
		return false, r.ownerErr
	}
	return r.allowed, nil
}

func (r *testProjectCollabResolver) setAllowed(allowed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.allowed = allowed
}

func (r *testProjectCollabResolver) setProjectID(projectID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.projectID = projectID
}

// --- test helpers ---

func newTestProjectCollabServer(
	t *testing.T,
	resolver *testProjectCollabResolver,
	verifier *testJWTVerifier,
	cfg *config.Config,
) *httptest.Server {
	t.Helper()

	if cfg == nil {
		cfg = &config.Config{}
	}

	projectRegistry := NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil)))

	h := NewCollabHandler(
		resolver,
		&noopProposalService{},
		&noopProposalStore{},
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		cfg,
		projectRegistry,
		nil,
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}", h.ConnectProject)
	return httptest.NewServer(mux)
}

func readWSJSONMessage(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	var raw string
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		t.Fatalf("receive ws JSON message: %v", err)
	}
	var msg map[string]any
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatalf("decode ws JSON message %q: %v", raw, err)
	}
	return msg
}

func readWSJSONMessageWithTimeout(t *testing.T, conn *websocket.Conn, timeout time.Duration) (map[string]any, bool) {
	t.Helper()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	defer func() {
		_ = conn.SetDeadline(time.Time{})
	}()

	var raw string
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		return nil, false
	}
	var msg map[string]any
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatalf("decode ws JSON message %q: %v", raw, err)
	}
	return msg, true
}

func dialProjectWS(t *testing.T, serverURL string, projectID string) *websocket.Conn {
	t.Helper()
	wsURL := asWebSocketURL(t, serverURL, "/ws/projects/"+projectID)
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial project websocket: %v", err)
	}
	return conn
}

func authenticateWS(t *testing.T, conn *websocket.Conn, token string) {
	t.Helper()
	if err := websocket.Message.Send(conn, token); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	// Read the project:connected ack that signals auth success.
	ack := readWSJSONMessage(t, conn)
	if ack["type"] != "project:connected" {
		t.Fatalf("expected project:connected after auth, got %v", ack["type"])
	}
}

// --- Tests ---

var (
	testProjectID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	testDocID1    = "11111111-1111-1111-1111-111111111111"
	testDocID2    = "22222222-2222-2222-2222-222222222222"
	testUserID    = "cccccccc-cccc-cccc-cccc-cccccccccccc"
	testToken     = "valid-project-token"
)

// TestProjectWS_AuthExpiredForBadToken verifies that a bad JWT token results
// in AUTH_EXPIRED (the token verification step fails).
func TestProjectWS_AuthExpiredForBadToken(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)

	// Send bad token directly (don't use authenticateWS which expects project:connected).
	if err := websocket.Message.Send(conn, "bad-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_EXPIRED" {
		t.Fatalf("expected AUTH_EXPIRED, got %q", got.Code)
	}
}

// [unit-tester:keep] security boundary -- blank auth bootstrap messages must be rejected
func TestProjectWS_AuthFailedForBlankToken(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)

	if err := websocket.Message.Send(conn, "   "); err != nil {
		t.Fatalf("send blank auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_FAILED" {
		t.Fatalf("expected AUTH_FAILED, got %q", got.Code)
	}
}

// [unit-tester:keep] security boundary -- authenticated project ws users must have UUID subjects
func TestProjectWS_AuthFailedForNonUUIDUserID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: "not-a-uuid"}},
		},
	}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)

	if err := websocket.Message.Send(conn, testToken); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_FAILED" {
		t.Fatalf("expected AUTH_FAILED, got %q", got.Code)
	}
}

// TestProjectWS_AuthDeniedForBlockedProdPattern verifies that blocked identities
// receive AUTH_FAILED with "authentication failed" message.
func TestProjectWS_AuthDeniedForBlockedProdPattern(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {
				RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID},
				Email:            "test-9@my-domain.com",
			},
		},
	}
	server := newTestProjectCollabServer(t, resolver, verifier, &config.Config{
		Environment:           "prod",
		BlockedProdIdentities: []string{"test-*@my-domain.com"},
	})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)

	if err := websocket.Message.Send(conn, testToken); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_FAILED" {
		t.Fatalf("expected AUTH_FAILED, got %q", got.Code)
	}
	if got.Message != "authentication failed" {
		t.Fatalf("expected message %q, got %q", "authentication failed", got.Message)
	}
}

func TestProjectWS_MalformedProjectID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	resp, err := http.Get(server.URL + "/ws/projects/not-a-uuid")
	if err != nil {
		t.Fatalf("http get: %v", err)
	}
	defer closeHTTPBody(t, resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, resp.StatusCode)
	}
}

// TestProjectWS_HeartbeatAfterConnect verifies that the heartbeat loop
// tolerates a client ack and keeps the socket alive.
func TestProjectWS_HeartbeatAfterConnect(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Send a heartbeat and verify the socket stays alive.
	hb := map[string]string{"type": "heartbeat"}
	hbBytes, _ := json.Marshal(hb)
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("send heartbeat: %v", err)
	}

	// Send a second heartbeat to confirm the socket is still open after the first.
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("socket should still be alive after heartbeat, but send failed: %v", err)
	}
}

// TestProjectWS_UnknownMessageTypeIgnored verifies that unknown JSON message
// types are silently ignored and the socket stays alive.
func TestProjectWS_UnknownMessageTypeIgnored(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	server := newTestProjectCollabServer(t, resolver, verifier, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Send unknown message type
	msg := map[string]string{"type": "unknown:future:message"}
	msgBytes, _ := json.Marshal(msg)
	if err := websocket.Message.Send(conn, string(msgBytes)); err != nil {
		t.Fatalf("send unknown message: %v", err)
	}

	// No error response expected — verify socket is alive by sending heartbeat.
	extra, ok := readWSJSONMessageWithTimeout(t, conn, 200*time.Millisecond)
	if ok {
		t.Fatalf("expected no response for unknown message type, got %v", extra)
	}

	hb := map[string]string{"type": "heartbeat"}
	hbBytes, _ := json.Marshal(hb)
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("socket should still be alive after unknown message, but send failed: %v", err)
	}
}
