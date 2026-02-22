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
	serviceCollab "meridian/internal/service/collab"
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

	broadcaster := serviceCollab.NewInMemoryDocumentBroadcaster()
	sessionManager := serviceCollab.NewDocumentSessionManager(store, store, &noopContentLoader{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 500)
	subscriptionSvc := serviceCollab.NewSubscriptionService(
		sessionManager,
		broadcaster,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		10,
	)

	h := NewCollabHandler(
		resolver,
		broadcaster,
		subscriptionSvc,
		proposalService,
		proposalStore,
		verifier,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{},
	)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/projects/{projectId}", h.ConnectProject)
	return httptest.NewServer(mux)
}

// subscribeDocOnProjectWS performs the full subscribe handshake:
// sends doc:subscribe, drains sync-step1 binary, proposal:snapshot, and doc:subscribed.
func subscribeDocOnProjectWS(t *testing.T, conn *websocket.Conn, documentID string) {
	t.Helper()
	cmd := map[string]string{"type": "doc:subscribe", "documentId": documentID}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}
	// Drain: binary sync-step1, proposal:snapshot JSON, doc:subscribed JSON
	_ = readWSBinaryMessage(t, conn)
	_ = readWSRawMessage(t, conn) // proposal:snapshot
	_ = readWSRawMessage(t, conn) // doc:subscribed
}

func TestProjectWS_ProposalSnapshotAfterSubscribe(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
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

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")

	// Send doc:subscribe — manually read the subscribe sequence to inspect proposal:snapshot
	cmd := map[string]string{"type": "doc:subscribe", "documentId": docID.String()}
	cmdBytes, _ := json.Marshal(cmd)
	if err := websocket.Message.Send(conn, string(cmdBytes)); err != nil {
		t.Fatalf("send doc:subscribe: %v", err)
	}

	_ = readWSBinaryMessage(t, conn) // sync-step1
	raw := readWSRawMessage(t, conn) // proposal:snapshot

	var event struct {
		Type       string                   `json:"type"`
		DocumentID string                   `json:"documentId"`
		Proposals  []map[string]interface{} `json:"proposals"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("decode proposal snapshot: %v", err)
	}

	if event.Type != wsTypeProposalSnapshot {
		t.Fatalf("expected type %q, got %q", wsTypeProposalSnapshot, event.Type)
	}
	if event.DocumentID != docID.String() {
		t.Fatalf("expected snapshot documentId %q, got %q", docID, event.DocumentID)
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

func TestProjectWS_ProposalAcceptDispatchAndBroadcast(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "55555555-5555-5555-5555-555555555555"}},
		},
	}
	store := &testCollabStore{}

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

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

	acceptMsg := proposalAcceptCommand{
		Type:           wsTypeProposalAccept,
		DocumentID:     documentID.String(),
		ProposalID:     proposalID.String(),
		IdempotencyKey: "accept-key",
	}
	if err := websocket.JSON.Send(conn, acceptMsg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	updateMsg := readWSBinaryMessage(t, conn)
	updateEnvelope, updateDocID, updatePayload, err := unframeEnvelope(updateMsg)
	if err != nil {
		t.Fatalf("unframe update message: %v", err)
	}
	if updateEnvelope != collabEnvelopeUpdate {
		t.Fatalf("expected collab update envelope, got %d", updateEnvelope)
	}
	if updateDocID != documentID {
		t.Fatalf("expected update documentId %s, got %s", documentID, updateDocID)
	}
	if len(updatePayload) == 0 {
		t.Fatalf("expected non-empty update payload")
	}

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

func TestProjectWS_ProposalGroupAcceptResultEvent(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "88888888-8888-8888-8888-888888888888"}},
		},
	}
	store := &testCollabStore{}

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

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

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

// TestProjectWS_ProposalAcceptNonSubscribedDocument verifies that a proposal:accept
// for a document that isn't subscribed gets a doc:error with NOT_SUBSCRIBED code.
// (Migrated from legacy per-doc WS test for missing documentId.)
func TestProjectWS_ProposalAcceptNonSubscribedDocument(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "12121212-1212-1212-1212-121212121212"}},
		},
	}
	store := &testCollabStore{}

	documentID := uuid.MustParse("13131313-1313-1313-1313-131313131313")
	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

	// Send proposal:accept WITHOUT documentId — routes to empty string → NOT_SUBSCRIBED
	msg := map[string]string{
		"type":           wsTypeProposalAccept,
		"proposalId":     "14141414-1414-1414-1414-141414141414",
		"idempotencyKey": "k",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:accept: %v", err)
	}

	// In project WS, missing documentId means NOT_SUBSCRIBED via doc:error
	got := readWSJSONMessage(t, conn)
	if got["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", got["type"])
	}
	if got["code"] != "NOT_SUBSCRIBED" {
		t.Fatalf("expected NOT_SUBSCRIBED, got %v", got["code"])
	}
	if len(proposalService.acceptReqs) != 0 {
		t.Fatalf("expected no accept calls, got %d", len(proposalService.acceptReqs))
	}
}

// TestProjectWS_ProposalRejectNonSubscribedDocument verifies that a proposal:reject
// for a document that isn't subscribed gets a doc:error with NOT_SUBSCRIBED code.
// (Migrated from legacy per-doc WS test for mismatched documentId.)
func TestProjectWS_ProposalRejectNonSubscribedDocument(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "15151515-1515-1515-1515-151515151515"}},
		},
	}
	store := &testCollabStore{}

	documentID := uuid.MustParse("16161616-1616-1616-1616-161616161616")
	proposalService := &testProposalService{}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

	// Send proposal:reject with a DIFFERENT documentId than the one subscribed
	msg := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: "17171717-1717-1717-1717-171717171717",
		ProposalID: "18181818-1818-1818-1818-181818181818",
	}
	if err := websocket.JSON.Send(conn, msg); err != nil {
		t.Fatalf("send proposal:reject: %v", err)
	}

	// In project WS, mismatched documentId means NOT_SUBSCRIBED via doc:error
	got := readWSJSONMessage(t, conn)
	if got["type"] != "doc:error" {
		t.Fatalf("expected doc:error, got %v", got["type"])
	}
	if got["code"] != "NOT_SUBSCRIBED" {
		t.Fatalf("expected NOT_SUBSCRIBED, got %v", got["code"])
	}
	if len(proposalService.rejectReqs) != 0 {
		t.Fatalf("expected no reject calls, got %d", len(proposalService.rejectReqs))
	}
}

func TestProjectWS_ProposalAcceptErrorMapping_IdempotencyConflict(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "dddddddd-dddd-dddd-dddd-dddddddddddd"}},
		},
	}
	store := &testCollabStore{}

	documentID := uuid.MustParse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
	proposalService := &testProposalService{
		acceptErr: domain.NewConflictError("idempotency_key", "k", "key conflict"),
	}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

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
	store := &testCollabStore{}

	documentID := uuid.MustParse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
	proposalService := &testProposalService{
		acceptErr: domain.NewRateLimitError("too many pending accept operations"),
	}
	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, proposalService, &noopProposalStore{})
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, documentID.String())

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

func TestProjectWS_ProposalRequestUpdate(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}
	store := &testCollabStore{}

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

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, docID.String())

	// Send proposal:requestUpdate
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

func TestProjectWS_ProposalRequestUpdateNotFound(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}
	store := &testCollabStore{}

	docID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	// Empty proposal store — proposal not found
	proposalStore := &testProposalStore{}

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, docID.String())

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

func TestProjectWS_ProposalRequestUpdateWrongDocument(t *testing.T) {
	resolver := &testProjectCollabResolver{allowed: true, projectID: testProposalProjectID}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			"valid-token": {RegisteredClaims: jwt.RegisteredClaims{Subject: "11111111-1111-1111-1111-111111111111"}},
		},
	}
	store := &testCollabStore{}

	// The document the user is subscribed to
	subscribedDocID := uuid.MustParse("22222222-2222-2222-2222-222222222222")
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

	server := newTestProjectCollabServerWithProposalDeps(t, resolver, verifier, store, &noopProposalService{}, proposalStore)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProposalProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, "valid-token")
	subscribeDocOnProjectWS(t, conn, subscribedDocID.String())

	msg := map[string]string{
		"type":       wsTypeProposalRequestUpdate,
		"documentId": subscribedDocID.String(),
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
