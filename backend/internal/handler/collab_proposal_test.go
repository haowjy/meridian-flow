package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"

	"meridian/internal/config"
	"meridian/internal/domain"
	"meridian/internal/domain/models"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// testProposalProjectID is the project ID used by proposal tests.
const testProposalProjectID = "dddddddd-dddd-dddd-dddd-dddddddddddd"

type testProposalStore struct {
	proposals []collabModels.Proposal
}

func (s *testProposalStore) Create(_ context.Context, _ *collabModels.Proposal) error {
	return nil
}

func (s *testProposalStore) GetByID(_ context.Context, id uuid.UUID) (*collabModels.Proposal, error) {
	for i := range s.proposals {
		if s.proposals[i].ID == id {
			return &s.proposals[i], nil
		}
	}
	return nil, domain.NewNotFoundError("proposal", id.String())
}

func (s *testProposalStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	documentID uuid.UUID,
	status collabModels.ProposalStatus,
	source collabModels.ProposalSource,
) (int, error) {
	count := 0
	for _, proposal := range s.proposals {
		if proposal.DocumentID != documentID {
			continue
		}
		if proposal.Status != status {
			continue
		}
		if proposal.Source != source {
			continue
		}
		count++
	}
	return count, nil
}

func (s *testProposalStore) ListByDocument(
	_ context.Context,
	documentID uuid.UUID,
	status *collabModels.ProposalStatus,
	limit int,
	offset int,
) ([]collabModels.Proposal, error) {
	filtered := make([]collabModels.Proposal, 0, len(s.proposals))
	for _, proposal := range s.proposals {
		if proposal.DocumentID != documentID {
			continue
		}
		if status != nil && proposal.Status != *status {
			continue
		}
		filtered = append(filtered, proposal)
	}

	if offset >= len(filtered) {
		return []collabModels.Proposal{}, nil
	}

	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}

	out := make([]collabModels.Proposal, 0, end-offset)
	out = append(out, filtered[offset:end]...)
	return out, nil
}

func (s *testProposalStore) ListByGroup(
	_ context.Context,
	_ uuid.UUID,
	_ *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	return nil, nil
}

func (s *testProposalStore) MarkAccepted(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *testProposalStore) MarkRejected(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *testProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

type testProposalService struct {
	acceptReqs      []collabSvc.AcceptProposalRequest
	acceptResult    *collabSvc.AcceptProposalResult
	acceptErr       error
	rejectReqs      []collabSvc.RejectProposalRequest
	rejectResult    *collabSvc.RejectProposalResult
	rejectErr       error
	groupAcceptReqs []collabSvc.GroupAcceptRequest
	groupResult     *collabSvc.GroupAcceptResult
	groupErr        error
}

func (s *testProposalService) CreateProposal(_ context.Context, _ collabSvc.CreateProposalRequest) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *testProposalService) AcceptProposal(_ context.Context, req collabSvc.AcceptProposalRequest) (*collabSvc.AcceptProposalResult, error) {
	s.acceptReqs = append(s.acceptReqs, req)
	if s.acceptErr != nil {
		return nil, s.acceptErr
	}
	if s.acceptResult != nil {
		return s.acceptResult, nil
	}
	return &collabSvc.AcceptProposalResult{}, nil
}

func (s *testProposalService) RejectProposal(_ context.Context, req collabSvc.RejectProposalRequest) (*collabSvc.RejectProposalResult, error) {
	s.rejectReqs = append(s.rejectReqs, req)
	if s.rejectErr != nil {
		return nil, s.rejectErr
	}
	if s.rejectResult != nil {
		return s.rejectResult, nil
	}
	return &collabSvc.RejectProposalResult{}, nil
}

func (s *testProposalService) GroupAccept(_ context.Context, req collabSvc.GroupAcceptRequest) (*collabSvc.GroupAcceptResult, error) {
	s.groupAcceptReqs = append(s.groupAcceptReqs, req)
	if s.groupErr != nil {
		return nil, s.groupErr
	}
	if s.groupResult != nil {
		return s.groupResult, nil
	}
	return &collabSvc.GroupAcceptResult{
		Payload: collabModels.GroupAcceptResponsePayload{},
	}, nil
}

// newTestProjectCollabServerWithProposalDeps creates a project WS test server
// with custom proposal service and store dependencies.
func newTestProjectCollabServerWithProposalDeps(
	t *testing.T,
	resolver *testProjectCollabResolver,
	verifier *testJWTVerifier,
	proposalService collabSvc.ProposalService,
	proposalStore collabSvc.ProposalStore,
) *httptest.Server {
	t.Helper()

	if proposalService == nil {
		proposalService = &noopProposalService{}
	}
	if proposalStore == nil {
		proposalStore = &noopProposalStore{}
	}

	projectRegistry := NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil)))

	h := NewCollabHandler(
		resolver,
		proposalService,
		proposalStore,
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
		projectRegistry,
		nil,
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}", h.ConnectProject)
	return httptest.NewServer(mux)
}

func newTestProjectCollabServerWithExplicitDeps(
	t *testing.T,
	resolver collabSvc.DocumentResolver,
	verifier *testJWTVerifier,
	proposalService collabSvc.ProposalService,
	proposalStore collabSvc.ProposalStore,
) *httptest.Server {
	t.Helper()

	h := NewCollabHandler(
		resolver,
		proposalService,
		proposalStore,
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
		NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil))),
		nil,
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}", h.ConnectProject)
	return httptest.NewServer(mux)
}

func TestProjectWS_ProposalAcceptDispatchAndBroadcast(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "55555555-5555-5555-5555-555555555555"}},
		},
	}

	proposalID := uuid.MustParse("66666666-6666-6666-6666-666666666666")
	documentID := uuid.MustParse("77777777-7777-7777-7777-777777777777")
	proposalService := &testProposalService{
		acceptResult: &collabSvc.AcceptProposalResult{
			Payload: collabModels.ProposalAcceptResponsePayload{
				ProposalID: proposalID,
			},
			Mutations: []collabSvc.ProposalMutationIntent{
				{
					DocumentID: documentID,
					ProposalID: proposalID,
					Status:     collabModels.ProposalStatusAccepted,
					YjsUpdate:  []byte{0x01, 0x02, 0x03},
				},
			},
		},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	// Send proposal:accept directly (no subscription needed in v2).
	acceptMsg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     documentID.String(),
		ProposalID:     proposalID.String(),
		IdempotencyKey: "accept-key",
	}
	if err := websocket.JSON.Send(conn, acceptMsg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	// Read proposal:statusChanged broadcast (JSON only; Yjs binary goes via document WS).
	statusRaw := readWSRawMessage(t, conn)
	var statusEvent proposalStatusChangedEvent
	if err := json.Unmarshal(statusRaw, &statusEvent); err != nil {
		t.Fatalf("decode proposal:statusChanged: %v", err)
	}
	if statusEvent.Type != wsTypeProposalStatusChanged {
		t.Fatalf("expected statusChanged type, got %q", statusEvent.Type)
	}
	if statusEvent.DocumentID != documentID.String() {
		t.Fatalf("expected statusChanged documentId %q, got %q", documentID, statusEvent.DocumentID)
	}
	if statusEvent.ProposalID != proposalID.String() || statusEvent.Status != string(collabModels.ProposalStatusAccepted) {
		t.Fatalf("unexpected status event: %+v", statusEvent)
	}

	if len(proposalService.acceptReqs) != 1 {
		t.Fatalf("expected one accept call, got %d", len(proposalService.acceptReqs))
	}
	gotReq := proposalService.acceptReqs[0]
	expectedHash, err := buildCanonicalRequestHash(map[string]any{
		"action":     wsTypeProposalAccept,
		"documentId": documentID.String(),
		"proposalId": proposalID.String(),
		"userId":     "55555555-5555-5555-5555-555555555555",
	})
	if err != nil {
		t.Fatalf("build expected hash: %v", err)
	}
	if gotReq.RequestHash != expectedHash {
		t.Fatalf("unexpected request hash: got %q want %q", gotReq.RequestHash, expectedHash)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectWS_ProposalAcceptIdempotencyReplay(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "56565656-5656-5656-5656-565656565656"}},
		},
	}

	documentID := uuid.MustParse("67676767-6767-6767-6767-676767676767")
	proposalService := &testProposalService{
		acceptResult: &collabSvc.AcceptProposalResult{IsReplay: true},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     documentID.String(),
		ProposalID:     uuid.MustParse("78787878-7878-7878-7878-787878787878").String(),
		IdempotencyKey: "replay-key",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "IDEMPOTENCY_REPLAY" {
		t.Fatalf("expected IDEMPOTENCY_REPLAY, got %q", got.Code)
	}
}

func TestProjectWS_ProposalGroupAcceptResultEvent(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "88888888-8888-8888-8888-888888888888"}},
		},
	}

	groupID := uuid.MustParse("99999999-9999-9999-9999-999999999999")
	documentID := uuid.MustParse("aaaaaaaa-1111-1111-1111-111111111111")
	proposalService := &testProposalService{
		groupResult: &collabSvc.GroupAcceptResult{
			Payload: collabModels.GroupAcceptResponsePayload{
				Outcomes: []collabModels.GroupAcceptOutcome{
					{
						ProposalID: uuid.MustParse("aaaaaaaa-0000-0000-0000-000000000000"),
						Status:     collabModels.GroupAcceptOutcomeStatusAccepted,
					},
					{
						ProposalID: uuid.MustParse("bbbbbbbb-0000-0000-0000-000000000000"),
						Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
						Error:      ptrString("apply failed"),
					},
				},
			},
		},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalGroupAcceptCommand{
		Type:           wsTypeProposalGroupAccept,
		DocumentID:     documentID.String(),
		GroupID:        groupID.String(),
		IdempotencyKey: "group-key",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:groupAccept: %v", err)
	}

	raw := readWSRawMessage(t, conn)
	var event proposalGroupAcceptResultEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode group result event: %v", err)
	}
	if event.Type != wsTypeProposalGroupAcceptEvent {
		t.Fatalf("expected type %q, got %q", wsTypeProposalGroupAcceptEvent, event.Type)
	}
	if event.DocumentID != documentID.String() {
		t.Fatalf("expected group result documentId %q, got %q", documentID, event.DocumentID)
	}
	if len(event.Outcomes) != 2 {
		t.Fatalf("expected 2 outcomes, got %d", len(event.Outcomes))
	}

	if len(proposalService.groupAcceptReqs) != 1 {
		t.Fatalf("expected one group accept call, got %d", len(proposalService.groupAcceptReqs))
	}
	gotReq := proposalService.groupAcceptReqs[0]
	expectedHash, err := buildCanonicalRequestHash(map[string]any{
		"action":     wsTypeProposalGroupAccept,
		"documentId": documentID.String(),
		"groupId":    groupID.String(),
		"userId":     "88888888-8888-8888-8888-888888888888",
	})
	if err != nil {
		t.Fatalf("build expected hash: %v", err)
	}
	if gotReq.RequestHash != expectedHash {
		t.Fatalf("unexpected request hash: got %q want %q", gotReq.RequestHash, expectedHash)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectWS_ProposalGroupAcceptRequiresIdempotencyKey(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "89898989-8989-8989-8989-898989898989"}},
		},
	}

	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalGroupAcceptCommand{
		Type:       wsTypeProposalGroupAccept,
		DocumentID: uuid.MustParse("90909090-9090-9090-9090-909090909090").String(),
		GroupID:    uuid.MustParse("91919191-9191-9191-9191-919191919191").String(),
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:groupAccept: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got %q", got.Code)
	}
	if len(proposalService.groupAcceptReqs) != 0 {
		t.Fatalf("expected no group accept calls, got %d", len(proposalService.groupAcceptReqs))
	}
}

// TestProjectWS_ProposalAcceptMissingDocumentID verifies that a proposal:accept
// without documentId gets an INTERNAL_ERROR because the empty string fails UUID parsing.
func TestProjectWS_ProposalAcceptMissingDocumentID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "12121212-1212-1212-1212-121212121212"}},
		},
	}

	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	// Send proposal:accept WITHOUT documentId — the empty string fails UUID parsing
	// in handleProjectProposalCommand.
	msg := map[string]string{
		"type":           wsTypeProposalAccept,
		"proposalId":     "14141414-1414-1414-1414-141414141414",
		"idempotencyKey": "k",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got %q", got.Code)
	}
	if len(proposalService.acceptReqs) != 0 {
		t.Fatalf("expected no accept calls, got %d", len(proposalService.acceptReqs))
	}
}

// [unit-tester:keep] security boundary -- cross-project document commands must be rejected per message
func TestProjectWS_ProposalAcceptProjectMismatchReturnsDocError(t *testing.T) {
	resolver := &testProjectCollabResolver{
		allowed:   true,
		projectID: "abababab-abab-abab-abab-abababababab",
	}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "15151515-1515-1515-1515-151515151515"}},
		},
	}

	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     "17171717-1717-1717-1717-171717171717",
		ProposalID:     "18181818-1818-1818-1818-181818181818",
		IdempotencyKey: "project-mismatch-key",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSJSONMessage(t, conn)
	if got["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", got["type"])
	}
	if got["code"] != "PROJECT_MISMATCH" {
		t.Fatalf("expected PROJECT_MISMATCH, got %v", got["code"])
	}
	if len(proposalService.acceptReqs) != 0 {
		t.Fatalf("expected no accept calls, got %d", len(proposalService.acceptReqs))
	}
}

// TestProjectWS_ProposalAcceptAccessDenied verifies that a proposal:accept
// for a document the user doesn't own returns FORBIDDEN via doc:error.
func TestProjectWS_ProposalAcceptAccessDenied(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: false, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "15151515-1515-1515-1515-151515151515"}},
		},
	}

	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	// Send proposal:accept for a document the user doesn't own.
	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     "17171717-1717-1717-1717-171717171717",
		ProposalID:     "18181818-1818-1818-1818-181818181818",
		IdempotencyKey: "access-denied-key",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSJSONMessage(t, conn)
	if got["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", got["type"])
	}
	if got["code"] != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got %v", got["code"])
	}
	if len(proposalService.acceptReqs) != 0 {
		t.Fatalf("expected no accept calls, got %d", len(proposalService.acceptReqs))
	}
}

func TestProjectWS_ProposalAcceptErrorMapping_IdempotencyConflict(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "dddddddd-dddd-dddd-dddd-dddddddddddd"}},
		},
	}

	documentID := uuid.MustParse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
	proposalService := &testProposalService{
		acceptErr: domain.NewConflictError("idempotency_key", "k", "key conflict"),
	}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     documentID.String(),
		ProposalID:     "ffffffff-ffff-ffff-ffff-ffffffffffff",
		IdempotencyKey: "k",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "IDEMPOTENCY_KEY_CONFLICT" {
		t.Fatalf("expected IDEMPOTENCY_KEY_CONFLICT, got %q", got.Code)
	}
}

func TestProjectWS_ProposalAcceptErrorMapping_RateLimited(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "dddddddd-dddd-dddd-dddd-dddddddddddd"}},
		},
	}

	documentID := uuid.MustParse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
	proposalService := &testProposalService{
		acceptErr: domain.NewRateLimitError("too many pending accept operations"),
	}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     documentID.String(),
		ProposalID:     "ffffffff-ffff-ffff-ffff-ffffffffffff",
		IdempotencyKey: "k",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "RATE_LIMITED" {
		t.Fatalf("expected RATE_LIMITED, got %q", got.Code)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectWS_ProposalRejectInvalidProposalID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "abababab-1111-1111-1111-111111111111"}},
		},
	}

	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: uuid.MustParse("cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd").String(),
		ProposalID: "not-a-uuid",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:reject: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got %q", got.Code)
	}
	if len(proposalService.rejectReqs) != 0 {
		t.Fatalf("expected no reject calls, got %d", len(proposalService.rejectReqs))
	}
}

func TestProjectWS_ProposalRequestUpdate(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}

	docID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	proposalID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	threadID := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	agentRunID := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	userID := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	proposalStore := &testProposalStore{
		proposals: []collabModels.Proposal{
			{
				ID:                proposalID,
				DocumentID:        docID,
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "editing_agent",
				ThreadID:          threadID,
				AgentRunID:        agentRunID,
				Status:            collabModels.ProposalStatusProposed,
				YjsUpdate:         []byte{0x01, 0x02, 0x03},
				CreatedByUserID:   userID,
				CreatedAt:         time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
			},
		},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	// Send proposal:requestUpdate directly (no subscription needed in v2).
	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": docID.String(),
		"proposalId": proposalID.String(),
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:requestUpdate: %v", err)
	}

	raw := readWSRawMessage(t, conn)
	var event proposalUpdateDataEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode proposal:updateData: %v", err)
	}
	if event.Type != wsTypeProposalUpdateData {
		t.Fatalf("expected type %q, got %q", wsTypeProposalUpdateData, event.Type)
	}
	if event.DocumentID != docID.String() {
		t.Fatalf("expected documentId %q, got %q", docID, event.DocumentID)
	}
	if event.ProposalID != proposalID.String() {
		t.Fatalf("expected proposalId %q, got %q", proposalID, event.ProposalID)
	}
	if event.YjsUpdate == "" {
		t.Fatal("expected non-empty yjsUpdate")
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectWS_ProposalRequestUpdateStoreUnavailable(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "12121212-3434-5656-7878-909090909090"}},
		},
	}

	server := newTestProjectCollabServerWithExplicitDeps(t, resolver, verifier, &noopProposalService{}, nil)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": uuid.MustParse("abababab-2222-2222-2222-222222222222").String(),
		"proposalId": uuid.MustParse("cdcdcdcd-3333-3333-3333-333333333333").String(),
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:requestUpdate: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got %q", got.Code)
	}
}

func TestProjectWS_ProposalRequestUpdateNotFound(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}

	docID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	// Empty proposal store — proposal not found
	proposalStore := &testProposalStore{}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": docID.String(),
		"proposalId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:requestUpdate: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "PROPOSAL_NOT_FOUND" {
		t.Fatalf("expected PROPOSAL_NOT_FOUND, got %q", got.Code)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectWS_ProposalRequestUpdateInvalidProposalID(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "44444444-1111-1111-1111-111111111111"}},
		},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, &noopProposalService{}, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": uuid.MustParse("55555555-2222-2222-2222-222222222222").String(),
		"proposalId": "not-a-uuid",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:requestUpdate: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got %q", got.Code)
	}
}

func TestProjectWS_ProposalRequestUpdateWrongDocument(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}

	// The document the user sends the command with
	commandDocID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	// The document the proposal actually belongs to
	otherDocID := uuid.MustParse("99999999-9999-9999-9999-999999999999")
	proposalID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	threadID := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	agentRunID := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	userID := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	proposalStore := &testProposalStore{
		proposals: []collabModels.Proposal{
			{
				ID:                proposalID,
				DocumentID:        otherDocID, // belongs to a different document
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "editing_agent",
				ThreadID:          threadID,
				AgentRunID:        agentRunID,
				Status:            collabModels.ProposalStatusProposed,
				YjsUpdate:         []byte{0x01},
				CreatedByUserID:   userID,
				CreatedAt:         time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
			},
		},
	}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": commandDocID.String(),
		"proposalId": proposalID.String(),
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:requestUpdate: %v", err)
	}

	got := readWSErrorMessage(t, conn)
	if got.Code != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got %q", got.Code)
	}
}

func readWSRawMessage(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	var raw []byte
	if err := websocket.Message.Receive(conn, &raw); err != nil {
		t.Fatalf("receive ws raw message: %v", err)
	}
	return raw
}

func ptrString(v string) *string {
	return &v
}
