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

func (s *testCollabStore) LoadContentForBootstrap(_ context.Context, _ string) (string, error) {
	return "", nil
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
