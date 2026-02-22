package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/config"
	"meridian/internal/domain/models"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	serviceCollab "meridian/internal/service/collab"
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

type spySessionManager struct {
	inner serviceCollab.SessionLifecycle

	mu           sync.Mutex
	acquireCalls map[string]int
	releaseCalls map[string]int
}

func newSpySessionManager(inner serviceCollab.SessionLifecycle) *spySessionManager {
	return &spySessionManager{
		inner:        inner,
		acquireCalls: make(map[string]int),
		releaseCalls: make(map[string]int),
	}
}

func (s *spySessionManager) Acquire(ctx context.Context, docID string) (*serviceCollab.DocumentSession, error) {
	session, err := s.inner.Acquire(ctx, docID)
	if err == nil {
		s.mu.Lock()
		s.acquireCalls[docID]++
		s.mu.Unlock()
	}
	return session, err
}

func (s *spySessionManager) Release(ctx context.Context, docID string) error {
	err := s.inner.Release(ctx, docID)
	if err == nil {
		s.mu.Lock()
		s.releaseCalls[docID]++
		s.mu.Unlock()
	}
	return err
}

func (s *spySessionManager) acquireCount(docID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.acquireCalls[docID]
}

func (s *spySessionManager) releaseCount(docID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.releaseCalls[docID]
}

type spyDocumentBroadcaster struct {
	inner collabSvc.DocumentBroadcaster

	mu               sync.Mutex
	subscribeCalls   map[string]int
	unsubscribeCalls map[string]int
}

func newSpyDocumentBroadcaster(inner collabSvc.DocumentBroadcaster) *spyDocumentBroadcaster {
	return &spyDocumentBroadcaster{
		inner:            inner,
		subscribeCalls:   make(map[string]int),
		unsubscribeCalls: make(map[string]int),
	}
}

func (s *spyDocumentBroadcaster) Subscribe(docID string, conn collabSvc.Connection) error {
	err := s.inner.Subscribe(docID, conn)
	if err == nil {
		s.mu.Lock()
		s.subscribeCalls[docID]++
		s.mu.Unlock()
	}
	return err
}

func (s *spyDocumentBroadcaster) Unsubscribe(docID string, conn collabSvc.Connection) {
	s.inner.Unsubscribe(docID, conn)
	s.mu.Lock()
	s.unsubscribeCalls[docID]++
	s.mu.Unlock()
}

func (s *spyDocumentBroadcaster) Broadcast(docID string, update []byte, exclude collabSvc.Connection) {
	s.inner.Broadcast(docID, update, exclude)
}

func (s *spyDocumentBroadcaster) subscribeCount(docID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subscribeCalls[docID]
}

func (s *spyDocumentBroadcaster) unsubscribeCount(docID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unsubscribeCalls[docID]
}

// --- test helpers ---

func newTestProjectCollabServer(
	t *testing.T,
	resolver *testProjectCollabResolver,
	verifier *testJWTVerifier,
	store *testCollabStore,
) *httptest.Server {
	return newTestProjectCollabServerWithDeps(t, resolver, verifier, store, nil, nil)
}

func newTestProjectCollabServerWithDeps(
	t *testing.T,
	resolver *testProjectCollabResolver,
	verifier *testJWTVerifier,
	store *testCollabStore,
	broadcaster collabSvc.DocumentBroadcaster,
	sessionManager serviceCollab.SessionLifecycle,
) *httptest.Server {
	t.Helper()

	if broadcaster == nil {
		broadcaster = serviceCollab.NewInMemoryDocumentBroadcaster()
	}
	if sessionManager == nil {
		sessionManager = serviceCollab.NewDocumentSessionManager(store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	}

	subscriptionSvc := serviceCollab.NewSubscriptionService(
		sessionManager,
		broadcaster,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		10, // max subscriptions per connection
	)

	h := NewCollabHandler(
		resolver,
		broadcaster,
		subscriptionSvc,
		&noopProposalService{},
		&noopProposalStore{},
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
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

func TestProjectWS_AuthFailed(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)

	// Send bad token directly (don't use authenticateWS which expects project:connected).
	if err := websocket.Message.Send(conn, "bad-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_FAILED" {
		t.Fatalf("expected AUTH_FAILED, got %q", got.Code)
	}
}

func TestProjectWS_MalformedProjectID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
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

func TestProjectWS_DocSubscribeSuccess(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Send doc:subscribe
	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}

	// Expect: 1) binary sync-step1 frame, 2) proposal:snapshot JSON, 3) doc:subscribed JSON
	// Read sync-step1 binary frame
	msg1 := readWSBinaryMessage(t, conn)
	env, docUUID, payload, err := unframeEnvelope(msg1)
	if err != nil {
		t.Fatalf("unframe sync-step1: %v", err)
	}
	if env != collabEnvelopeSyncStep1 {
		t.Fatalf("expected sync-step1 envelope %d, got %d", collabEnvelopeSyncStep1, env)
	}
	if docUUID != uuid.MustParse(testDocID1) {
		t.Fatalf("expected doc UUID %s, got %s", testDocID1, docUUID)
	}
	if len(payload) == 0 {
		t.Fatalf("expected non-empty sync-step1 payload")
	}

	// Read proposal:snapshot
	msg2 := readWSJSONMessage(t, conn)
	if msg2["type"] != "proposal:snapshot" {
		t.Fatalf("expected proposal:snapshot, got %v", msg2["type"])
	}
	if msg2["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg2["documentId"])
	}

	// Read doc:subscribed
	msg3 := readWSJSONMessage(t, conn)
	if msg3["type"] != "doc:subscribed" {
		t.Fatalf("expected doc:subscribed, got %v", msg3["type"])
	}
	if msg3["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg3["documentId"])
	}
}

func TestProjectWS_DocSubscribeIdempotent(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	baseSessionManager := serviceCollab.NewDocumentSessionManager(store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	sessionSpy := newSpySessionManager(baseSessionManager)
	broadcasterSpy := newSpyDocumentBroadcaster(serviceCollab.NewInMemoryDocumentBroadcaster())
	server := newTestProjectCollabServerWithDeps(t, resolver, verifier, store, broadcasterSpy, sessionSpy)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)
	canonicalDocumentID := uuid.MustParse(testDocID1).String()

	// First subscribe
	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send first doc:subscribe: %v", err)
	}

	// Drain: sync-step1 (binary), proposal:snapshot, doc:subscribed
	_ = readWSBinaryMessage(t, conn)
	_ = readWSJSONMessage(t, conn)
	_ = readWSJSONMessage(t, conn)

	// Second subscribe (duplicate)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send second doc:subscribe: %v", err)
	}

	// Should only get doc:subscribed ack, no extra sync-step1 or proposal:snapshot
	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:subscribed" {
		t.Fatalf("expected idempotent doc:subscribed, got %v", msg["type"])
	}
	if msg["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg["documentId"])
	}

	// Verify no extra messages
	extra, ok := readWSJSONMessageWithTimeout(t, conn, 200*time.Millisecond)
	if ok {
		t.Fatalf("expected no extra messages after idempotent subscribe, got %v", extra)
	}

	if got := sessionSpy.acquireCount(canonicalDocumentID); got != 1 {
		t.Fatalf("expected exactly 1 session acquire for idempotent subscribe, got %d", got)
	}
	if got := broadcasterSpy.subscribeCount(canonicalDocumentID); got != 1 {
		t.Fatalf("expected exactly 1 broadcaster subscribe for idempotent subscribe, got %d", got)
	}
}

func TestProjectWS_DocSubscribeCanonicalizesMixedCaseUUID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	baseSessionManager := serviceCollab.NewDocumentSessionManager(store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	sessionSpy := newSpySessionManager(baseSessionManager)
	broadcasterSpy := newSpyDocumentBroadcaster(serviceCollab.NewInMemoryDocumentBroadcaster())
	server := newTestProjectCollabServerWithDeps(t, resolver, verifier, store, broadcasterSpy, sessionSpy)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, strings.ToUpper(testProjectID))
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	mixedCaseDocumentID := strings.ToUpper(testDocID1)
	canonicalDocumentID := uuid.MustParse(testDocID1).String()
	cmd := map[string]string{"type": "doc:subscribe", "documentId": mixedCaseDocumentID}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send mixed-case doc:subscribe: %v", err)
	}

	msg1 := readWSBinaryMessage(t, conn)
	_, docUUID, _, err := unframeEnvelope(msg1)
	if err != nil {
		t.Fatalf("unframe sync-step1: %v", err)
	}
	if docUUID.String() != canonicalDocumentID {
		t.Fatalf("expected canonical doc UUID %s, got %s", canonicalDocumentID, docUUID.String())
	}

	msg2 := readWSJSONMessage(t, conn)
	if msg2["type"] != "proposal:snapshot" {
		t.Fatalf("expected proposal:snapshot, got %v", msg2["type"])
	}
	if msg2["documentId"] != canonicalDocumentID {
		t.Fatalf("expected canonical documentId %s, got %v", canonicalDocumentID, msg2["documentId"])
	}

	msg3 := readWSJSONMessage(t, conn)
	if msg3["type"] != "doc:subscribed" {
		t.Fatalf("expected doc:subscribed, got %v", msg3["type"])
	}
	if msg3["documentId"] != canonicalDocumentID {
		t.Fatalf("expected canonical documentId %s, got %v", canonicalDocumentID, msg3["documentId"])
	}

	cmdLower := map[string]string{"type": "doc:subscribe", "documentId": strings.ToLower(testDocID1)}
	cmdLowerBytes, _ := json.Marshal(cmdLower)
	if err := websocket.Message.Send(conn, string(cmdLowerBytes)); err != nil {
		t.Fatalf("send lowercase doc:subscribe: %v", err)
	}

	msg4 := readWSJSONMessage(t, conn)
	if msg4["type"] != "doc:subscribed" {
		t.Fatalf("expected idempotent doc:subscribed, got %v", msg4["type"])
	}
	if msg4["documentId"] != canonicalDocumentID {
		t.Fatalf("expected canonical documentId %s, got %v", canonicalDocumentID, msg4["documentId"])
	}

	if got := sessionSpy.acquireCount(canonicalDocumentID); got != 1 {
		t.Fatalf("expected exactly 1 session acquire for mixed-case subscribe, got %d", got)
	}
	if got := broadcasterSpy.subscribeCount(canonicalDocumentID); got != 1 {
		t.Fatalf("expected exactly 1 broadcaster subscribe for mixed-case subscribe, got %d", got)
	}
}

func TestProjectWS_DocSubscribeMalformedUUID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	cmd := map[string]string{"type": "doc:subscribe", "documentId": "not-a-uuid"}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}
	if msg["code"] != "INVALID_DOCUMENT_ID" {
		t.Fatalf("expected INVALID_DOCUMENT_ID, got %v", msg["code"])
	}
}

func TestProjectWS_DocSubscribeUnauthorized(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: false, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}
	if msg["code"] != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got %v", msg["code"])
	}

	// Verify socket is still alive — send heartbeat
	hb := map[string]string{"type": "heartbeat"}
	hbBytes, _ := json.Marshal(hb)
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("socket should still be alive after doc:error, but send failed: %v", err)
	}
}

func TestProjectWS_DocSubscribeProjectMismatch(t *testing.T) {
	differentProjectID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	resolver := &testProjectCollabResolver{allowed: true, projectID: differentProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}
	if msg["code"] != "PROJECT_MISMATCH" {
		t.Fatalf("expected PROJECT_MISMATCH, got %v", msg["code"])
	}

	// Verify socket is still alive
	hb := map[string]string{"type": "heartbeat"}
	hbBytes, _ := json.Marshal(hb)
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("socket should still be alive after project mismatch doc:error: %v", err)
	}
}

func TestProjectWS_DocSubscribeLimitExceeded(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Subscribe to max (10) documents
	for i := 0; i < 10; i++ {
		docID := uuid.New().String()
		cmd := map[string]string{"type": "doc:subscribe", "documentId": docID}
		cmdBytes, _ := json.Marshal(cmd)
		if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
			t.Fatalf("send doc:subscribe %d: %v", i, err)
		}
		// Drain: binary sync-step1, proposal:snapshot, doc:subscribed
		_ = readWSBinaryMessage(t, conn)
		_ = readWSJSONMessage(t, conn)
		_ = readWSJSONMessage(t, conn)
	}

	// 11th should fail
	cmd := map[string]string{"type": "doc:subscribe", "documentId": uuid.New().String()}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send 11th doc:subscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}
	if msg["code"] != "SUBSCRIPTION_LIMIT" {
		t.Fatalf("expected SUBSCRIPTION_LIMIT, got %v", msg["code"])
	}
}

func TestProjectWS_DocUnsubscribe(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Subscribe first
	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}
	// Drain subscribe sequence
	_ = readWSBinaryMessage(t, conn)
	_ = readWSJSONMessage(t, conn)
	_ = readWSJSONMessage(t, conn)

	// Unsubscribe
	unsub := map[string]string{"type": "doc:unsubscribe", "documentId": testDocID1}
	unsubBytes, _ := json.Marshal(unsub)
	if err := websocket.Message.Send(conn, string(unsubBytes)); err != nil {
		t.Fatalf("send doc:unsubscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:unsubscribed" {
		t.Fatalf("expected doc:unsubscribed, got %v", msg["type"])
	}
	if msg["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg["documentId"])
	}
}

func TestProjectWS_DocUnsubscribeNotSubscribed(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Unsubscribe without subscribing first — should be safe
	unsub := map[string]string{"type": "doc:unsubscribe", "documentId": testDocID1}
	unsubBytes, _ := json.Marshal(unsub)
	if err := websocket.Message.Send(conn, string(unsubBytes)); err != nil {
		t.Fatalf("send doc:unsubscribe: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:unsubscribed" {
		t.Fatalf("expected doc:unsubscribed, got %v", msg["type"])
	}
}

func TestProjectWS_ServerInvalidationAccessRevoked(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	baseSessionManager := serviceCollab.NewDocumentSessionManager(store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	sessionSpy := newSpySessionManager(baseSessionManager)
	broadcasterSpy := newSpyDocumentBroadcaster(serviceCollab.NewInMemoryDocumentBroadcaster())
	server := newTestProjectCollabServerWithDeps(t, resolver, verifier, store, broadcasterSpy, sessionSpy)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}
	_ = readWSBinaryMessage(t, conn)
	_ = readWSJSONMessage(t, conn)
	_ = readWSJSONMessage(t, conn)

	resolver.setAllowed(false)
	docUUID := uuid.MustParse(testDocID1)
	frame := frameEnvelope(collabEnvelopeAwareness, docUUID, []byte{0x01})
	if err := websocket.Message.Send(conn, frame); err != nil {
		t.Fatalf("send invalidating frame: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:unsubscribed" {
		t.Fatalf("expected doc:unsubscribed, got %v", msg["type"])
	}
	if msg["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg["documentId"])
	}
	if msg["reason"] != "access_revoked" {
		t.Fatalf("expected reason access_revoked, got %v", msg["reason"])
	}

	if got := sessionSpy.releaseCount(testDocID1); got != 1 {
		t.Fatalf("expected exactly 1 session release after access revoke, got %d", got)
	}
	if got := broadcasterSpy.unsubscribeCount(testDocID1); got != 1 {
		t.Fatalf("expected exactly 1 broadcaster unsubscribe after access revoke, got %d", got)
	}
}

func TestProjectWS_ServerInvalidationProjectMismatch(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	baseSessionManager := serviceCollab.NewDocumentSessionManager(store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	sessionSpy := newSpySessionManager(baseSessionManager)
	broadcasterSpy := newSpyDocumentBroadcaster(serviceCollab.NewInMemoryDocumentBroadcaster())
	server := newTestProjectCollabServerWithDeps(t, resolver, verifier, store, broadcasterSpy, sessionSpy)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}
	_ = readWSBinaryMessage(t, conn)
	_ = readWSJSONMessage(t, conn)
	_ = readWSJSONMessage(t, conn)

	resolver.setProjectID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	docUUID := uuid.MustParse(testDocID1)
	frame := frameEnvelope(collabEnvelopeAwareness, docUUID, []byte{0x02})
	if err := websocket.Message.Send(conn, frame); err != nil {
		t.Fatalf("send invalidating frame: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:unsubscribed" {
		t.Fatalf("expected doc:unsubscribed, got %v", msg["type"])
	}
	if msg["documentId"] != testDocID1 {
		t.Fatalf("expected documentId %s, got %v", testDocID1, msg["documentId"])
	}
	if msg["reason"] != "project_mismatch" {
		t.Fatalf("expected reason project_mismatch, got %v", msg["reason"])
	}

	if got := sessionSpy.releaseCount(testDocID1); got != 1 {
		t.Fatalf("expected exactly 1 session release after project mismatch, got %d", got)
	}
	if got := broadcasterSpy.unsubscribeCount(testDocID1); got != 1 {
		t.Fatalf("expected exactly 1 broadcaster unsubscribe after project mismatch, got %d", got)
	}
}

func TestProjectWS_BinaryFrameNotSubscribed(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Send binary frame for a document we haven't subscribed to
	docUUID := uuid.MustParse(testDocID1)
	frame := frameEnvelope(collabEnvelopeAwareness, docUUID, []byte{0x01, 0x02})
	if err := websocket.Message.Send(conn, frame); err != nil {
		t.Fatalf("send binary frame: %v", err)
	}

	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}
	if msg["code"] != "NOT_SUBSCRIBED" {
		t.Fatalf("expected NOT_SUBSCRIBED, got %v", msg["code"])
	}

	// Verify socket is still alive
	hb := map[string]string{"type": "heartbeat"}
	hbBytes, _ := json.Marshal(hb)
	if err := websocket.Message.Send(conn, string(hbBytes)); err != nil {
		t.Fatalf("socket should still be alive after doc:error: %v", err)
	}
}

func TestProjectWS_DocErrorKeepsSocketAlive(t *testing.T) {
	// Subscribe to doc1, then send a bad binary frame for doc1 (corrupt sync payload).
	// Expect doc:error but socket stays alive for doc2 subscribe.
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}
	store := &testCollabStore{}
	server := newTestProjectCollabServer(t, resolver, verifier, store)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	// Subscribe to doc1
	cmd := map[string]string{"type": "doc:subscribe", "documentId": testDocID1}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}
	_ = readWSBinaryMessage(t, conn) // sync-step1
	_ = readWSJSONMessage(t, conn)   // proposal:snapshot
	_ = readWSJSONMessage(t, conn)   // doc:subscribed

	// Send corrupt binary frame for doc1
	docUUID := uuid.MustParse(testDocID1)
	corruptFrame := frameEnvelope(collabEnvelopeUpdate, docUUID, []byte{0xFF, 0xFF, 0xFF})
	if err := websocket.Message.Send(conn, corruptFrame); err != nil {
		t.Fatalf("send corrupt frame: %v", err)
	}

	// Should get doc:error (not close the socket)
	msg := readWSJSONMessage(t, conn)
	if msg["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", msg["type"])
	}

	// Socket should still be alive — subscribe to doc2
	cmd2 := map[string]string{"type": "doc:subscribe", "documentId": testDocID2}
	cmd2Bytes, _ := json.Marshal(cmd2)
	if err := websocket.Message.Send(conn, string(cmd2Bytes)); err != nil {
		t.Fatalf("send doc:subscribe for doc2: %v", err)
	}
	_ = readWSBinaryMessage(t, conn) // sync-step1
	_ = readWSJSONMessage(t, conn)   // proposal:snapshot

	msg2 := readWSJSONMessage(t, conn)
	if msg2["type"] != "doc:subscribed" {
		t.Fatalf("expected doc:subscribed for doc2, got %v", msg2["type"])
	}
	if msg2["documentId"] != testDocID2 {
		t.Fatalf("expected documentId %s, got %v", testDocID2, msg2["documentId"])
	}
}
