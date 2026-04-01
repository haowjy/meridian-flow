package collab

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	collab "meridian/internal/domain/collab"
)

func TestProposalServiceCreateProposal_FirstTurnProposalCreatesAITurnBookmark(t *testing.T) {
	docID := uuid.New()
	turnID := uuid.New()
	baseState, update := buildProposalValidationFixture(t)

	proposalStore := &fakeProposalServiceStore{
		countByDocumentAndTurnIDResult: 0,
	}
	runtime := &fakeProposalServiceRuntime{
		currentState: baseState,
	}
	service := NewProposalService(
		proposalStore,
		&fakeProposalServiceTxManager{},
		&fakeProposalServiceAuthorizer{},
		runtime,
		&fakeProposalAutoapplyResolver{effectiveAutoapply: true},
		&fakeDocumentPresenceTracker{hasActiveSubscribers: true},
		&fakeProposalServiceDocumentResolver{allow: true},
	)

	_, err := service.CreateProposal(context.Background(), collab.CreateProposalRequest{
		DocumentID:        docID,
		Source:            collab.ProposalSourceAI,
		ProducerAgentType: "assistant",
		ThreadID:          uuid.New(),
		TurnID:            &turnID,
		AgentRunID:        uuid.New(),
		YjsUpdate:         update,
		CreatedByUserID:   uuid.New(),
	})
	if err != nil {
		t.Fatalf("CreateProposal returned error: %v", err)
	}

	if len(runtime.aiTurnBookmarkCalls) != 1 {
		t.Fatalf("expected one ai_turn bookmark call, got %d", len(runtime.aiTurnBookmarkCalls))
	}
	if runtime.aiTurnBookmarkCalls[0].documentID != docID || runtime.aiTurnBookmarkCalls[0].turnID != turnID {
		t.Fatalf("unexpected ai_turn bookmark call: %+v", runtime.aiTurnBookmarkCalls[0])
	}
}

func TestProposalServiceCreateProposal_NonFirstTurnProposalSkipsAITurnBookmark(t *testing.T) {
	docID := uuid.New()
	turnID := uuid.New()
	baseState, update := buildProposalValidationFixture(t)

	proposalStore := &fakeProposalServiceStore{
		countByDocumentAndTurnIDResult: 3,
	}
	runtime := &fakeProposalServiceRuntime{
		currentState: baseState,
	}
	service := NewProposalService(
		proposalStore,
		&fakeProposalServiceTxManager{},
		&fakeProposalServiceAuthorizer{},
		runtime,
		&fakeProposalAutoapplyResolver{effectiveAutoapply: true},
		&fakeDocumentPresenceTracker{hasActiveSubscribers: true},
		&fakeProposalServiceDocumentResolver{allow: true},
	)

	_, err := service.CreateProposal(context.Background(), collab.CreateProposalRequest{
		DocumentID:        docID,
		Source:            collab.ProposalSourceAI,
		ProducerAgentType: "assistant",
		ThreadID:          uuid.New(),
		TurnID:            &turnID,
		AgentRunID:        uuid.New(),
		YjsUpdate:         update,
		CreatedByUserID:   uuid.New(),
	})
	if err != nil {
		t.Fatalf("CreateProposal returned error: %v", err)
	}

	if len(runtime.aiTurnBookmarkCalls) != 0 {
		t.Fatalf("expected no ai_turn bookmark call, got %d", len(runtime.aiTurnBookmarkCalls))
	}
}

func TestProposalServiceCreateProposal_EnforcesDocumentAuthorization(t *testing.T) {
	docID := uuid.New()
	_, update := buildProposalValidationFixture(t)

	proposalStore := &fakeProposalServiceStore{}
	service := NewProposalService(
		proposalStore,
		&fakeProposalServiceTxManager{},
		&fakeProposalServiceAuthorizer{err: domain.NewForbiddenError("access denied")},
		&fakeProposalServiceRuntime{},
		&fakeProposalAutoapplyResolver{effectiveAutoapply: true},
		&fakeDocumentPresenceTracker{hasActiveSubscribers: false},
		&fakeProposalServiceDocumentResolver{allow: true},
	)

	_, err := service.CreateProposal(context.Background(), collab.CreateProposalRequest{
		DocumentID:      docID,
		Source:          collab.ProposalSourceUserSuggestion,
		ThreadID:        uuid.New(),
		AgentRunID:      uuid.New(),
		YjsUpdate:       update,
		CreatedByUserID: uuid.New(),
	})
	if err == nil || err.Error() != "access denied" {
		t.Fatalf("expected authorization error, got %v", err)
	}
	if proposalStore.createCalls != 0 {
		t.Fatalf("expected no proposal persistence on auth failure, got %d create calls", proposalStore.createCalls)
	}
}

func TestProposalServiceCreateProposal_AutoapplyDisabledKeepsProposalPending(t *testing.T) {
	docID := uuid.New()
	baseState, update := buildProposalValidationFixture(t)

	proposalStore := &fakeProposalServiceStore{}
	runtime := &fakeProposalServiceRuntime{
		currentState: baseState,
	}
	service := NewProposalService(
		proposalStore,
		&fakeProposalServiceTxManager{},
		&fakeProposalServiceAuthorizer{},
		runtime,
		&fakeProposalAutoapplyResolver{effectiveAutoapply: false},
		&fakeDocumentPresenceTracker{hasActiveSubscribers: false},
		&fakeProposalServiceDocumentResolver{allow: true},
	)

	proposal, err := service.CreateProposal(context.Background(), collab.CreateProposalRequest{
		DocumentID:      docID,
		Source:          collab.ProposalSourceUserSuggestion,
		ThreadID:        uuid.New(),
		AgentRunID:      uuid.New(),
		YjsUpdate:       update,
		CreatedByUserID: uuid.New(),
	})
	if err != nil {
		t.Fatalf("CreateProposal returned error: %v", err)
	}
	if proposal.Status != collab.ProposalStatusPending {
		t.Fatalf("expected pending proposal status, got %s", proposal.Status)
	}
	if proposalStore.createCalls != 1 {
		t.Fatalf("expected one proposal create call, got %d", proposalStore.createCalls)
	}
	if len(runtime.applyCalls) != 0 {
		t.Fatalf("expected no backend fallback apply, got %d apply calls", len(runtime.applyCalls))
	}
}

func buildProposalValidationFixture(t *testing.T) ([]byte, []byte) {
	t.Helper()

	doc := ycrdt.NewDoc("proposal-service-test", true, ycrdt.DefaultGCFilter, nil, false)
	content := doc.GetText("content")
	doc.Transact(func(_ *ycrdt.Transaction) {
		content.Insert(0, "hello", nil)
	}, nil)

	baseState := ycrdt.EncodeStateAsUpdate(doc, nil)
	stateVector := ycrdt.EncodeStateVector(doc, nil, ycrdt.NewUpdateEncoderV1())
	doc.Transact(func(_ *ycrdt.Transaction) {
		content.Insert(content.Length(), " world", nil)
	}, nil)
	update := ycrdt.EncodeStateAsUpdate(doc, stateVector)
	return baseState, update
}

type fakeProposalServiceTxManager struct{}

func (f *fakeProposalServiceTxManager) ExecTx(ctx context.Context, fn domain.TxFn) error {
	return fn(ctx)
}

type fakeProposalServiceStore struct {
	createCalls                    int
	countByDocumentAndTurnIDResult int
}

func (s *fakeProposalServiceStore) Create(_ context.Context, _ *collab.Proposal) error {
	s.createCalls++
	return nil
}

func (s *fakeProposalServiceStore) GetByID(_ context.Context, _ uuid.UUID) (*collab.Proposal, error) {
	return nil, nil
}

func (s *fakeProposalServiceStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	_ uuid.UUID,
	_ collab.ProposalStatus,
	_ collab.ProposalSource,
) (int, error) {
	return 0, nil
}

func (s *fakeProposalServiceStore) CountByDocumentAndTurnID(_ context.Context, _ uuid.UUID, _ uuid.UUID) (int, error) {
	return s.countByDocumentAndTurnIDResult, nil
}

func (s *fakeProposalServiceStore) ListByDocument(_ context.Context, _ uuid.UUID, _ *collab.ProposalStatus, _ int, _ int) ([]collab.Proposal, error) {
	return nil, nil
}

func (s *fakeProposalServiceStore) UpsertStatus(_ context.Context, _ uuid.UUID, _ collab.ProposalStatus) error {
	return nil
}

func (s *fakeProposalServiceStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}

func (s *fakeProposalServiceStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collab.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

type fakeProposalServiceRuntime struct {
	currentState []byte

	aiTurnBookmarkCalls []proposalBookmarkCall
	applyCalls          []proposalApplyCall
}

type proposalBookmarkCall struct {
	documentID uuid.UUID
	turnID     uuid.UUID
}

type proposalApplyCall struct {
	documentID uuid.UUID
	origin     string
}

func (r *fakeProposalServiceRuntime) ApplyUpdate(_ context.Context, documentID uuid.UUID, _ []byte, origin string) error {
	r.applyCalls = append(r.applyCalls, proposalApplyCall{
		documentID: documentID,
		origin:     origin,
	})
	return nil
}

func (r *fakeProposalServiceRuntime) GetStateSnapshot(_ context.Context, _ uuid.UUID) ([]byte, bool, error) {
	return r.currentState, true, nil
}

func (r *fakeProposalServiceRuntime) GetCurrentState(_ context.Context, _ uuid.UUID) ([]byte, error) {
	return r.currentState, nil
}

func (r *fakeProposalServiceRuntime) CreateAITurnBookmark(_ context.Context, documentID uuid.UUID, turnID uuid.UUID) error {
	r.aiTurnBookmarkCalls = append(r.aiTurnBookmarkCalls, proposalBookmarkCall{
		documentID: documentID,
		turnID:     turnID,
	})
	return nil
}

type fakeDocumentPresenceTracker struct {
	hasActiveSubscribers bool
}

func (t *fakeDocumentPresenceTracker) HasActiveSubscribers(string) bool {
	return t.hasActiveSubscribers
}

type fakeProposalServiceDocumentResolver struct {
	allow bool
	err   error
}

func (r *fakeProposalServiceDocumentResolver) ResolveDocument(_ context.Context, _ string) (*collab.CollabDocRef, error) {
	return nil, nil
}

func (r *fakeProposalServiceDocumentResolver) VerifyOwnership(_ context.Context, _ string, _ string) (bool, error) {
	if r.err != nil {
		return false, r.err
	}
	return r.allow, nil
}

type fakeProposalServiceAuthorizer struct {
	err error
}

func (a *fakeProposalServiceAuthorizer) CanAccessProject(context.Context, string, string) error {
	return nil
}
func (a *fakeProposalServiceAuthorizer) CanAccessFolder(context.Context, string, string) error {
	return nil
}
func (a *fakeProposalServiceAuthorizer) CanAccessDocument(context.Context, string, string) error {
	return a.err
}
func (a *fakeProposalServiceAuthorizer) CanAccessThread(context.Context, string, string) error {
	return nil
}
func (a *fakeProposalServiceAuthorizer) CanAccessTurn(context.Context, string, string) error {
	return nil
}

type fakeProposalAutoapplyResolver struct {
	effectiveAutoapply bool
	err                error
}

func (r *fakeProposalAutoapplyResolver) ResolveEffectiveAutoapply(context.Context, string) (bool, error) {
	if r.err != nil {
		return false, r.err
	}
	return r.effectiveAutoapply, nil
}

var _ authdomain.ResourceAuthorizer = (*fakeProposalServiceAuthorizer)(nil)
var _ collab.AutoapplyResolver = (*fakeProposalAutoapplyResolver)(nil)
