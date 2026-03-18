package collab

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
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
		runtime,
		&fakeOwnerTabPresenceTracker{hasOwnerTabs: true},
	)

	_, err := service.CreateProposal(context.Background(), collabSvc.CreateProposalRequest{
		DocumentID:        docID,
		Source:            collabModels.ProposalSourceAI,
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
		runtime,
		&fakeOwnerTabPresenceTracker{hasOwnerTabs: true},
	)

	_, err := service.CreateProposal(context.Background(), collabSvc.CreateProposalRequest{
		DocumentID:        docID,
		Source:            collabModels.ProposalSourceAI,
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

func (f *fakeProposalServiceTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	return fn(ctx)
}

type fakeProposalServiceStore struct {
	createCalls                    int
	countByDocumentAndTurnIDResult int
}

func (s *fakeProposalServiceStore) Create(_ context.Context, _ *collabModels.Proposal) error {
	s.createCalls++
	return nil
}

func (s *fakeProposalServiceStore) GetByID(_ context.Context, _ uuid.UUID) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *fakeProposalServiceStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ collabModels.ProposalSource,
) (int, error) {
	return 0, nil
}

func (s *fakeProposalServiceStore) CountByDocumentAndTurnID(_ context.Context, _ uuid.UUID, _ uuid.UUID) (int, error) {
	return s.countByDocumentAndTurnIDResult, nil
}

func (s *fakeProposalServiceStore) ListByDocument(_ context.Context, _ uuid.UUID, _ *collabModels.ProposalStatus, _ int, _ int) ([]collabModels.Proposal, error) {
	return nil, nil
}

func (s *fakeProposalServiceStore) UpsertStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus) error {
	return nil
}

func (s *fakeProposalServiceStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}

func (s *fakeProposalServiceStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

type fakeProposalServiceRuntime struct {
	currentState []byte

	aiTurnBookmarkCalls []proposalBookmarkCall
}

type proposalBookmarkCall struct {
	documentID uuid.UUID
	turnID     uuid.UUID
}

func (r *fakeProposalServiceRuntime) ApplyUpdate(_ context.Context, _ uuid.UUID, _ []byte, _ string) error {
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

type fakeOwnerTabPresenceTracker struct {
	hasOwnerTabs bool
}

func (t *fakeOwnerTabPresenceTracker) HasOwnerTabs(uuid.UUID) bool {
	return t.hasOwnerTabs
}
