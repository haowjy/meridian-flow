package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/net/websocket"
	"meridian/internal/domain/models"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// --- shared test doubles used by collab_project_test.go and collab_proposal_test.go ---

type testJWTVerifier struct {
	tokens map[string]*models.AuthClaims
}

func (v *testJWTVerifier) VerifyToken(tokenString string) (*models.AuthClaims, error) {
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

func (s *testCollabStore) SaveState(_ context.Context, _ string, state []byte, _ string) error {
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

func (s *noopProposalService) SetProposalOffset(_ context.Context, _ collabSvc.SetProposalOffsetRequest) error {
	return nil
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

func (s *noopProposalStore) CountByDocumentAndTurnID(_ context.Context, _ uuid.UUID, _ uuid.UUID) (int, error) {
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

func (s *noopProposalStore) UpsertStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus) error {
	return nil
}

func (s *noopProposalStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}

func (s *noopProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

// --- shared test helpers ---

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

func closeWSConn(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.Close(); err != nil {
		t.Errorf("close websocket connection: %v", err)
	}
}

func closeHTTPBody(t *testing.T, body interface{ Close() error }) {
	t.Helper()
	if err := body.Close(); err != nil {
		t.Errorf("close HTTP response body: %v", err)
	}
}
