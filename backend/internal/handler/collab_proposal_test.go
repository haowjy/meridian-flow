package handler

import (
	"context"
	"encoding/json"
	"errors"
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
	serviceCollab "meridian/internal/service/collab"
)

type testProposalStore struct {
	proposals []collabModels.Proposal
}

func (s *testProposalStore) Create(_ context.Context, _ *collabModels.Proposal) error {
	return nil
}

func (s *testProposalStore) GetByID(_ context.Context, _ uuid.UUID) (*collabModels.Proposal, error) {
	return nil, errors.New("not implemented")
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

func newTestCollabServerWithProposalDeps(
	t *testing.T,
	resolver *testCollabResolver,
	verifier *testJWTVerifier,
	store *testCollabStore,
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

	h := NewCollabHandler(
		resolver,
		serviceCollab.NewInMemoryDocumentBroadcaster(),
		serviceCollab.NewDocumentSessionManager(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 500),
		proposalService,
		proposalStore,
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/documents/{id}", h.ConnectDocument)
	return httptest.NewServer(mux)
}

func TestCollabHandler_WSProposalSnapshotAfterHandshake(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}
	store := &testCollabStore{}

	docID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	proposed1ID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	proposed2ID := uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	rejectedID := uuid.MustParse("cccccccc-cccc-cccc-cccc-cccccccccccc")
	threadID := uuid.MustParse("33333333-3333-3333-3333-333333333333")
	agentRunID := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	userID := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	proposalStore := &testProposalStore{
		proposals: []collabModels.Proposal{
			{
				ID:                proposed2ID,
				DocumentID:        docID,
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "editing_agent",
				ThreadID:          threadID,
				AgentRunID:        agentRunID,
				Status:            collabModels.ProposalStatusProposed,
				YjsUpdate:         []byte{0x01},
				CreatedByUserID:   userID,
				CreatedAt:         time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC),
			},
			{
				ID:                proposed1ID,
				DocumentID:        docID,
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "editing_agent",
				ThreadID:          threadID,
				AgentRunID:        agentRunID,
				Status:            collabModels.ProposalStatusProposed,
				YjsUpdate:         []byte{0x02},
				CreatedByUserID:   userID,
				CreatedAt:         time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC),
			},
			{
				ID:                rejectedID,
				DocumentID:        docID,
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "editing_agent",
				ThreadID:          threadID,
				AgentRunID:        agentRunID,
				Status:            collabModels.ProposalStatusRejected,
				CreatedByUserID:   userID,
				CreatedAt:         time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC),
			},
		},
	}

	server := newTestCollabServerWithProposalDeps(t, resolver, verifier, store, &noopProposalService{}, proposalStore)
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/22222222-2222-2222-2222-222222222222")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}
	if err := websocket.Message.Send(conn, buildEnvelopeSyncStep1(t)); err != nil {
		t.Fatalf("send sync step1: %v", err)
	}

	_ = readWSBinaryMessage(t, conn) // step2
	_ = readWSBinaryMessage(t, conn) // step1
	raw := readWSRawMessage(t, conn)

	var event struct {
		Type      string                   `json:"type"`
		Proposals []map[string]interface{} `json:"proposals"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode proposal snapshot: %v", err)
	}

	if event.Type != wsTypeProposalSnapshot {
		t.Fatalf("expected type %q, got %q", wsTypeProposalSnapshot, event.Type)
	}
	if len(event.Proposals) != 2 {
		t.Fatalf("expected 2 pending proposals, got %d", len(event.Proposals))
	}
	if event.Proposals[0]["id"] != proposed1ID.String() {
		t.Fatalf("expected first proposal %s, got %v", proposed1ID, event.Proposals[0]["id"])
	}
	if event.Proposals[1]["id"] != proposed2ID.String() {
		t.Fatalf("expected second proposal %s, got %v", proposed2ID, event.Proposals[1]["id"])
	}
	if _, ok := event.Proposals[0]["yjsUpdate"]; ok {
		t.Fatal("proposal:snapshot should not include yjsUpdate")
	}
}

func TestCollabHandler_WSProposalAcceptDispatchAndBroadcast(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "55555555-5555-5555-5555-555555555555"}},
		},
	}
	store := &testCollabStore{}

	proposalID := uuid.MustParse("66666666-6666-6666-6666-666666666666")
	proposalService := &testProposalService{
		acceptResult: &collabSvc.AcceptProposalResult{
			Payload: collabModels.ProposalAcceptResponsePayload{
				ProposalID: proposalID,
			},
			Mutations: []collabSvc.ProposalMutationIntent{
				{
					DocumentID: uuid.MustParse("77777777-7777-7777-7777-777777777777"),
					ProposalID: proposalID,
					Status:     collabModels.ProposalStatusAccepted,
					YjsUpdate:  []byte{0x01, 0x02, 0x03},
				},
			},
		},
	}

	server := newTestCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/77777777-7777-7777-7777-777777777777")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}
	if err := websocket.Message.Send(conn, buildEnvelopeSyncStep1(t)); err != nil {
		t.Fatalf("send sync step1: %v", err)
	}
	_ = readWSBinaryMessage(t, conn)
	_ = readWSBinaryMessage(t, conn)
	_ = readWSRawMessage(t, conn) // proposal:snapshot

	acceptMsg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		ProposalID:     proposalID.String(),
		IdempotencyKey: "accept-key",
	}
	if err := websocket.JSON.Send(conn, acceptMsg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	updateMsg := readWSBinaryMessage(t, conn)
	if len(updateMsg) < 2 || updateMsg[0] != collabEnvelopeUpdate {
		t.Fatalf("expected collab update frame, got %v", updateMsg)
	}

	statusRaw := readWSRawMessage(t, conn)
	var statusEvent proposalStatusChangedEvent
	if err := json.Unmarshal(statusRaw, &statusEvent); err != nil {
		t.Fatalf("decode proposal:statusChanged: %v", err)
	}
	if statusEvent.Type != wsTypeProposalStatusChanged {
		t.Fatalf("expected statusChanged type, got %q", statusEvent.Type)
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

func TestCollabHandler_WSProposalGroupAcceptResultEvent(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "88888888-8888-8888-8888-888888888888"}},
		},
	}
	store := &testCollabStore{}

	groupID := uuid.MustParse("99999999-9999-9999-9999-999999999999")
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

	server := newTestCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/aaaaaaaa-1111-1111-1111-111111111111")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}
	if err := websocket.Message.Send(conn, buildEnvelopeSyncStep1(t)); err != nil {
		t.Fatalf("send sync step1: %v", err)
	}
	_ = readWSBinaryMessage(t, conn)
	_ = readWSBinaryMessage(t, conn)
	_ = readWSRawMessage(t, conn) // proposal:snapshot

	msg := proposalGroupAcceptCommand{
		Type:           wsTypeProposalGroupAccept,
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
	if len(event.Outcomes) != 2 {
		t.Fatalf("expected 2 outcomes, got %d", len(event.Outcomes))
	}

	if len(proposalService.groupAcceptReqs) != 1 {
		t.Fatalf("expected one group accept call, got %d", len(proposalService.groupAcceptReqs))
	}
	gotReq := proposalService.groupAcceptReqs[0]
	expectedHash, err := buildCanonicalRequestHash(map[string]any{
		"action":     wsTypeProposalGroupAccept,
		"documentId": "aaaaaaaa-1111-1111-1111-111111111111",
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

func TestCollabHandler_WSProposalAcceptErrorMapping_IdempotencyConflict(t *testing.T) {
	resolver := &testCollabResolver{allowed: true}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "dddddddd-dddd-dddd-dddd-dddddddddddd"}},
		},
	}
	store := &testCollabStore{}

	proposalService := &testProposalService{
		acceptErr: domain.NewConflictError("idempotency_key", "k", "key conflict"),
	}
	server := newTestCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	wsURL := asWebSocketURL(t, server.URL, "/ws/documents/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
	conn, err := websocket.Dial(wsURL, "", "http://localhost/")
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer conn.Close()

	if err := websocket.Message.Send(conn, "valid-token"); err != nil {
		t.Fatalf("send auth token: %v", err)
	}
	if err := websocket.Message.Send(conn, buildEnvelopeSyncStep1(t)); err != nil {
		t.Fatalf("send sync step1: %v", err)
	}
	_ = readWSBinaryMessage(t, conn)
	_ = readWSBinaryMessage(t, conn)
	_ = readWSRawMessage(t, conn) // proposal:snapshot

	msg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
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
