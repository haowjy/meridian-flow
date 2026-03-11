package handler

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
)

type countingProjectAccessResolver struct {
	mu    sync.Mutex
	allow bool

	projectID string

	verifyOwnershipCalls int
	resolveDocumentCalls int
}

func (r *countingProjectAccessResolver) ResolveDocument(_ context.Context, docID string) (*collabModels.CollabDocRef, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.resolveDocumentCalls++
	return &collabModels.CollabDocRef{
		DocumentID: docID,
		ProjectID:  r.projectID,
	}, nil
}

func (r *countingProjectAccessResolver) VerifyOwnership(_ context.Context, _ string, _ string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.verifyOwnershipCalls++
	return r.allow, nil
}

func (r *countingProjectAccessResolver) callCounts() (verifyOwnership int, resolveDocument int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.verifyOwnershipCalls, r.resolveDocumentCalls
}

type countingRejectProposalService struct {
	mu          sync.Mutex
	rejectCalls int
}

func (s *countingRejectProposalService) CreateProposal(_ context.Context, _ collabSvc.CreateProposalRequest) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *countingRejectProposalService) AcceptProposal(_ context.Context, _ collabSvc.AcceptProposalRequest) (*collabSvc.AcceptProposalResult, error) {
	return &collabSvc.AcceptProposalResult{}, nil
}

func (s *countingRejectProposalService) RejectProposal(_ context.Context, _ collabSvc.RejectProposalRequest) (*collabSvc.RejectProposalResult, error) {
	s.mu.Lock()
	s.rejectCalls++
	s.mu.Unlock()

	return &collabSvc.RejectProposalResult{}, nil
}

func (s *countingRejectProposalService) GroupAccept(_ context.Context, _ collabSvc.GroupAcceptRequest) (*collabSvc.GroupAcceptResult, error) {
	return &collabSvc.GroupAcceptResult{Payload: collabModels.GroupAcceptResponsePayload{}}, nil
}

func (s *countingRejectProposalService) rejectCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rejectCalls
}

func newTestProjectCollabServerWithResolverAndProposalDeps(
	t *testing.T,
	resolver collabSvc.DocumentResolver,
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

func TestProjectWS_DocumentAccessCache_ReusesAccessChecksPerConnection(t *testing.T) {
	resolver := &countingProjectAccessResolver{
		allow:     true,
		projectID: testProjectID,
	}

	proposalService := &countingRejectProposalService{}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}

	server := newTestProjectCollabServerWithResolverAndProposalDeps(
		t,
		resolver,
		verifier,
		proposalService,
		&noopProposalStore{},
	)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	command1 := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("10101010-1010-1010-1010-101010101010").String(),
	}
	command2 := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("20202020-2020-2020-2020-202020202020").String(),
	}

	if err := websocket.JSON.Send(conn, command1); err != nil {
		t.Fatalf("send first proposal:reject: %v", err)
	}
	if err := websocket.JSON.Send(conn, command2); err != nil {
		t.Fatalf("send second proposal:reject: %v", err)
	}

	waitForCondition(t, 2*time.Second, func() bool {
		return proposalService.rejectCallCount() == 2
	}, "expected both proposal:reject commands to be processed")

	verifyCalls, resolveCalls := resolver.callCounts()
	if verifyCalls != 1 {
		t.Fatalf("expected VerifyOwnership to run once due to cache hit, got %d", verifyCalls)
	}
	if resolveCalls != 1 {
		t.Fatalf("expected ResolveDocument to run once due to cache hit, got %d", resolveCalls)
	}
}

// [unit-tester:keep] security boundary -- denied documents must not be cached on a connection
func TestProjectWS_DocumentAccessCache_DeniedDocumentsAreNotCached(t *testing.T) {
	resolver := &countingProjectAccessResolver{
		allow:     false,
		projectID: testProjectID,
	}

	proposalService := &countingRejectProposalService{}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}

	server := newTestProjectCollabServerWithResolverAndProposalDeps(
		t,
		resolver,
		verifier,
		proposalService,
		&noopProposalStore{},
	)
	defer server.Close()

	conn := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn)
	authenticateWS(t, conn, testToken)

	firstCommand := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("30303030-3030-3030-3030-303030303030").String(),
	}
	secondCommand := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("40404040-4040-4040-4040-404040404040").String(),
	}

	if err := websocket.JSON.Send(conn, firstCommand); err != nil {
		t.Fatalf("send first proposal:reject: %v", err)
	}
	if got := readWSJSONMessage(t, conn); got["code"] != "FORBIDDEN" {
		t.Fatalf("expected first doc:error FORBIDDEN, got %v", got["code"])
	}

	if err := websocket.JSON.Send(conn, secondCommand); err != nil {
		t.Fatalf("send second proposal:reject: %v", err)
	}
	if got := readWSJSONMessage(t, conn); got["code"] != "FORBIDDEN" {
		t.Fatalf("expected second doc:error FORBIDDEN, got %v", got["code"])
	}

	verifyCalls, resolveCalls := resolver.callCounts()
	if verifyCalls != 2 {
		t.Fatalf("expected VerifyOwnership to run twice because denied access is not cached, got %d", verifyCalls)
	}
	if resolveCalls != 0 {
		t.Fatalf("expected ResolveDocument to never run for denied access, got %d", resolveCalls)
	}
	if got := proposalService.rejectCallCount(); got != 0 {
		t.Fatalf("expected no reject calls when access is denied, got %d", got)
	}
}

// [unit-tester:keep] security boundary -- document access cache must stay scoped to one websocket connection
func TestProjectWS_DocumentAccessCache_IsScopedPerConnection(t *testing.T) {
	resolver := &countingProjectAccessResolver{
		allow:     true,
		projectID: testProjectID,
	}

	proposalService := &countingRejectProposalService{}
	verifier := &testJWTVerifier{
		tokens: map[string]*models.SupabaseClaims{
			testToken: {RegisteredClaims: jwt.RegisteredClaims{Subject: testUserID}},
		},
	}

	server := newTestProjectCollabServerWithResolverAndProposalDeps(
		t,
		resolver,
		verifier,
		proposalService,
		&noopProposalStore{},
	)
	defer server.Close()

	conn1 := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn1)
	authenticateWS(t, conn1, testToken)

	conn2 := dialProjectWS(t, server.URL, testProjectID)
	defer closeWSConn(t, conn2)
	authenticateWS(t, conn2, testToken)

	command1 := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("50505050-5050-5050-5050-505050505050").String(),
	}
	command2 := proposalRejectCommand{
		Type:       wsTypeProposalReject,
		DocumentID: testDocID1,
		ProposalID: uuid.MustParse("60606060-6060-6060-6060-606060606060").String(),
	}

	if err := websocket.JSON.Send(conn1, command1); err != nil {
		t.Fatalf("send conn1 proposal:reject: %v", err)
	}
	if err := websocket.JSON.Send(conn2, command2); err != nil {
		t.Fatalf("send conn2 proposal:reject: %v", err)
	}

	waitForCondition(t, 2*time.Second, func() bool {
		return proposalService.rejectCallCount() == 2
	}, "expected both connections to process proposal:reject commands")

	verifyCalls, resolveCalls := resolver.callCounts()
	if verifyCalls != 2 {
		t.Fatalf("expected VerifyOwnership to run once per connection, got %d", verifyCalls)
	}
	if resolveCalls != 2 {
		t.Fatalf("expected ResolveDocument to run once per connection, got %d", resolveCalls)
	}
}

func waitForCondition(t *testing.T, timeout time.Duration, condition func() bool, failureMsg string) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(failureMsg)
}
