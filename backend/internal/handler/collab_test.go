package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"golang.org/x/net/websocket"
	"meridian/internal/config"
	"meridian/internal/domain/models"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	serviceCollab "meridian/internal/service/collab"
)

type testCollabResolver struct {
	allowed   bool
	err       error
	gotDocID  string
	gotUserID string
}

func (r *testCollabResolver) ResolveDocument(_ context.Context, _ string) (*collabModels.CollabDocRef, error) {
	return nil, nil
}

func (r *testCollabResolver) VerifyOwnership(_ context.Context, docID string, userID string) (bool, error) {
	r.gotDocID = docID
	r.gotUserID = userID
	if r.err != nil {
		return false, r.err
	}
	return r.allowed, nil
}

type testJWTVerifier struct {
	tokens map[string]*models.SupabaseClaims
}

func (v *testJWTVerifier) VerifyToken(tokenString string) (*models.SupabaseClaims, error) {
	claims, ok := v.tokens[tokenString]
	if !ok {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func (v *testJWTVerifier) Close() error {
	return nil
}

type testCollabStore struct {
	state       []byte
	saveCalls   int
	snapCalls   int
	loadErr     error
	saveErr     error
	snapshotErr error
}

func (s *testCollabStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	return s.state, nil
}

func (s *testCollabStore) SaveState(_ context.Context, _ string, state []byte, _ string, _ string) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.saveCalls++
	s.state = state
	return nil
}

func (s *testCollabStore) SaveSnapshot(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ *string,
	_ *string,
) (string, error) {
	if s.snapshotErr != nil {
		return "", s.snapshotErr
	}
	s.snapCalls++
	return "", nil
}

func (s *testCollabStore) ListSnapshots(_ context.Context, _ string, _, _ int) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}

func (s *testCollabStore) GetSnapshot(_ context.Context, _ string) (*collabModels.SnapshotWithState, error) {
	return nil, nil
}

func (s *testCollabStore) DeleteSnapshot(_ context.Context, _ string) error {
	return nil
}

func (s *testCollabStore) DeleteExpiredAutoSnapshots(_ context.Context, _ int) (int64, error) {
	return 0, nil
}

type wsErrorResponse struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type noopProposalService struct{}

func (s *noopProposalService) CreateProposal(_ context.Context, _ collabSvc.CreateProposalRequest) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *noopProposalService) AcceptProposal(_ context.Context, _ collabSvc.AcceptProposalRequest) (*collabSvc.AcceptProposalResult, error) {
	return &collabSvc.AcceptProposalResult{}, nil
}

func (s *noopProposalService) RejectProposal(_ context.Context, _ collabSvc.RejectProposalRequest) (*collabSvc.RejectProposalResult, error) {
	return &collabSvc.RejectProposalResult{}, nil
}

func (s *noopProposalService) GroupAccept(_ context.Context, _ collabSvc.GroupAcceptRequest) (*collabSvc.GroupAcceptResult, error) {
	return &collabSvc.GroupAcceptResult{
		Payload: collabModels.GroupAcceptResponsePayload{},
	}, nil
}

type noopProposalStore struct{}

func (s *noopProposalStore) Create(_ context.Context, _ *collabModels.Proposal) error {
	return nil
}

func (s *noopProposalStore) GetByID(_ context.Context, _ uuid.UUID) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *noopProposalStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ collabModels.ProposalSource,
) (int, error) {
	return 0, nil
}

func (s *noopProposalStore) ListByDocument(
	_ context.Context,
	_ uuid.UUID,
	_ *collabModels.ProposalStatus,
	_ int,
	_ int,
) ([]collabModels.Proposal, error) {
	return nil, nil
}

func (s *noopProposalStore) ListByGroup(
	_ context.Context,
	_ uuid.UUID,
	_ *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	return nil, nil
}

func (s *noopProposalStore) MarkAccepted(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *noopProposalStore) MarkRejected(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *noopProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

func TestCollabHandler_WSAuthFailed(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/11111111-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "bad-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "AUTH_FAILED" {
		t.Fatalf("expected AUTH_FAILED, got %q", got.Code)
	}

	if resolver.gotUserID != "" {
		t.Fatalf("resolver should not run on auth failure; got user_id=%q", resolver.gotUserID)
	}
}

func TestCollabHandler_WSForbidden(t *testing.T) {
	resolver := &testCollabResolver{allowed: false}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"}},
		},
	}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/11111111-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got %q", got.Code)
	}
	if resolver.gotDocID != "11111111-1111-1111-1111-111111111111" || resolver.gotUserID != "user-1" {
		t.Fatalf("unexpected resolver inputs: doc=%q user=%q", resolver.gotDocID, resolver.gotUserID)
	}
}

func TestCollabHandler_WSMalformedDocumentID(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{tokens: map[string]*models.SupabaseClaims{}}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	resp, err := http.Get(server.URL + "/ws/documents/not-a-uuid")
	if err != nil {
		t.Fatalf("http get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, resp.StatusCode)
	}
}

func TestCollabHandler_WSSyncStep1Handshake(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}},
		},
	}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/11111111-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	step1 := buildEnvelopeSyncStep1(t)
	if err := websocket.Message.Send(conn, step1); err != nil {
		t.Fatalf("send sync step1: %v", err)
	}

	msg1 := readWSBinaryMessage(t, conn)
	if len(msg1) < 2 {
		t.Fatalf("expected non-empty first sync frame")
	}
	if msg1[0] != collabEnvelopeSyncStep2 {
		t.Fatalf("expected first frame envelope %d, got %d", collabEnvelopeSyncStep2, msg1[0])
	}

	msg2 := readWSBinaryMessage(t, conn)
	if len(msg2) < 2 {
		t.Fatalf("expected non-empty second sync frame")
	}
	if msg2[0] != collabEnvelopeSyncStep1 {
		t.Fatalf("expected second frame envelope %d, got %d", collabEnvelopeSyncStep1, msg2[0])
	}
}

func TestCollabHandler_WSCorruptSyncPayload(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}},
		},
	}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/11111111-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	if err := websocket.Message.Send(conn, []byte{collabEnvelopeUpdate, 0xFF, 0xFF, 0xFF}); err != nil {
		t.Fatalf("send corrupt update: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "RESET_REQUIRED" {
		t.Fatalf("expected RESET_REQUIRED, got %q", got.Code)
	}
}

func TestCollabHandler_WSInboundRateLimitAndRecovery(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "cccccccc-cccc-cccc-cccc-cccccccccccc"}},
		},
	}
	store := &testCollabStore{}
	server := newTestCollabServer(t, resolver, verifier, store)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/11111111-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}

	for i := 0; i < collabInboundRateLimit+1; i++ {
		if err := websocket.Message.Send(conn, []byte{collabEnvelopeAwareness}); err != nil {
			t.Fatalf("send burst message %d: %v", i, err)
		}
	}

	limited := readWSErrorMessage(t, conn)
	if limited.Code != "RATE_LIMITED" {
		t.Fatalf("expected RATE_LIMITED, got %q", limited.Code)
	}

	// This payload normally triggers RESET_REQUIRED, so lack of response confirms mute-drop behavior.
	if err := websocket.Message.Send(conn, []byte{collabEnvelopeUpdate, 0xFF, 0xFF, 0xFF}); err != nil {
		t.Fatalf("send muted corrupt update: %v", err)
	}
	if msg, ok := readWSErrorMessageWithTimeout(t, conn, 250*time.Millisecond); ok {
		t.Fatalf("expected no response during mute, got %+v", msg)
	}

	time.Sleep(collabInboundMutePeriod + 100*time.Millisecond)

	if err := websocket.Message.Send(conn, []byte{collabEnvelopeUpdate, 0xFF, 0xFF, 0xFF}); err != nil {
		t.Fatalf("send post-mute corrupt update: %v", err)
	}
	recovered := readWSErrorMessage(t, conn)
	if recovered.Code != "RESET_REQUIRED" {
		t.Fatalf("expected RESET_REQUIRED after mute, got %q", recovered.Code)
	}
}

func newTestCollabServer(
	t *testing.T,
	resolver *testCollabResolver,
	verifier *testJWTVerifier,
	store *testCollabStore,
) *httptest.Server {
	t.Helper()

	h := NewCollabHandler(
		resolver,
		serviceCollab.NewInMemoryDocumentBroadcaster(),
		serviceCollab.NewDocumentSessionManager(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 500),
		&noopProposalService{},
		&noopProposalStore{},
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/documents/{id}", h.ConnectDocument)
	return httptest.NewServer(mux)
}

func asWebSocketURL(t *testing.T, baseURL string, path string) string {
	t.Helper()
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse base URL: %v", err)
	}
	parsed.Scheme = "ws"
	parsed.Path = path
	return parsed.String()
}

func readWSErrorMessage(t *testing.T, conn *websocket.Conn) wsErrorResponse {
	t.Helper()

	var raw string
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		t.Fatalf("receive ws message: %v", err)
	}

	var msg wsErrorResponse
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatalf("decode ws message %q: %v", raw, err)
	}
	return msg
}

func readWSErrorMessageWithTimeout(t *testing.T, conn *websocket.Conn, timeout time.Duration) (wsErrorResponse, bool) {
	t.Helper()

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	defer func() {
		if err := conn.SetDeadline(time.Time{}); err != nil {
			t.Fatalf("clear read deadline: %v", err)
		}
	}()

	var raw string
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return wsErrorResponse{}, false
		}
		t.Fatalf("receive ws message with timeout: %v", err)
	}

	var msg wsErrorResponse
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatalf("decode ws message %q: %v", raw, err)
	}
	return msg, true
}

func readWSBinaryMessage(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()

	// Skip any text frames (e.g., proposal:snapshot) and return the next binary frame.
	for {
		var raw []byte
		if err := websocket.Message.Receive(conn, &raw); err != nil {
			t.Fatalf("receive ws binary message: %v", err)
		}
		// Text frames start with '{' (JSON). Skip them.
		if len(raw) > 0 && raw[0] == '{' {
			continue
		}
		return raw
	}
}

func buildEnvelopeSyncStep1(t *testing.T) []byte {
	t.Helper()

	doc := ycrdt.NewDoc("test-client", true, ycrdt.DefaultGCFilter, nil, false)
	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteSyncStep1(encoder, doc)
	payload := encoder.ToUint8Array()
	if len(payload) == 0 {
		t.Fatalf("empty sync-step1 payload")
	}

	frame := make([]byte, 1+len(payload))
	frame[0] = collabEnvelopeSyncStep1
	copy(frame[1:], payload)
	return frame
}
