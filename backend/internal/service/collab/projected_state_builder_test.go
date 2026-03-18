package collab

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
)

func TestProjectedStateBuilderListPendingProposalsForUser_DeterministicOrder(t *testing.T) {
	docID := uuid.New()
	userID := uuid.New()
	otherUserID := uuid.New()
	now := time.Now().UTC()

	p3 := collabModels.Proposal{
		ID:              uuid.MustParse("00000000-0000-0000-0000-000000000003"),
		DocumentID:      docID,
		Status:          collabModels.ProposalStatusPending,
		CreatedByUserID: userID,
		CreatedAt:       now.Add(3 * time.Minute),
	}
	p1 := collabModels.Proposal{
		ID:              uuid.MustParse("00000000-0000-0000-0000-000000000001"),
		DocumentID:      docID,
		Status:          collabModels.ProposalStatusPending,
		CreatedByUserID: userID,
		CreatedAt:       now.Add(1 * time.Minute),
	}
	p2 := collabModels.Proposal{
		ID:              uuid.MustParse("00000000-0000-0000-0000-000000000002"),
		DocumentID:      docID,
		Status:          collabModels.ProposalStatusPending,
		CreatedByUserID: otherUserID,
		CreatedAt:       now.Add(2 * time.Minute),
	}

	builder := &ProjectedStateBuilderService{
		stateStore:      &fakeProjectorStateStore{},
		proposalStore:   &fakeProjectorProposalStore{listByDocument: []collabModels.Proposal{p3, p1, p2}},
		proposalRuntime: &fakeProjectorRuntime{},
	}

	got, err := builder.listPendingProposalsForUser(context.Background(), docID, userID)
	if err != nil {
		t.Fatalf("listPendingProposalsForUser: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 proposals, got %d", len(got))
	}
	if got[0].ID != p1.ID || got[1].ID != p3.ID {
		t.Fatalf("unexpected proposal order: %s, %s", got[0].ID, got[1].ID)
	}
}

func TestProjectedStateBuilderBuildProjectedState_BootstrapsFromContent(t *testing.T) {
	docID := uuid.New()
	userID := uuid.New()

	docStore := &fakeProjectorStateStore{loadedState: nil} // empty yjs_state
	contentLoader := &fakeContentLoader{content: "# Hello World"}
	proposalStore := &fakeProjectorProposalStore{}
	runtime := &fakeProjectorRuntime{found: false}

	builder := &ProjectedStateBuilderService{
		stateStore:      docStore,
		proposalStore:   proposalStore,
		proposalRuntime: runtime,
		contentLoader:   contentLoader,
	}

	state, err := builder.BuildProjectedState(context.Background(), docID, userID)
	if err != nil {
		t.Fatalf("BuildProjectedState: %v", err)
	}
	if state == nil {
		t.Fatal("expected non-nil state")
	}

	// Verify content was bootstrapped correctly
	got := decodeDocContent(t, state)
	if got != "# Hello World" {
		t.Errorf("expected bootstrapped content %q, got %q", "# Hello World", got)
	}

	// Verify bootstrapped state was persisted
	if docStore.saveStateCalls != 1 {
		t.Fatalf("expected SaveState to be called once (persist bootstrap), got %d", docStore.saveStateCalls)
	}
}

func TestProjectedStateBuilderBuildProjectedState_EmptyContent(t *testing.T) {
	docID := uuid.New()
	userID := uuid.New()

	docStore := &fakeProjectorStateStore{loadedState: nil}
	contentLoader := &fakeContentLoader{content: ""} // empty document
	proposalStore := &fakeProjectorProposalStore{}
	runtime := &fakeProjectorRuntime{found: false}

	builder := &ProjectedStateBuilderService{
		stateStore:      docStore,
		proposalStore:   proposalStore,
		proposalRuntime: runtime,
		contentLoader:   contentLoader,
	}

	state, err := builder.BuildProjectedState(context.Background(), docID, userID)
	if err != nil {
		t.Fatalf("BuildProjectedState: %v", err)
	}
	if state == nil {
		t.Fatal("expected non-nil state (valid empty Y.Doc)")
	}

	// Empty content should produce valid empty Y.Doc state, not panic
	got := decodeDocContent(t, state)
	if got != "" {
		t.Errorf("expected empty content, got %q", got)
	}
	if docStore.saveStateCalls != 1 {
		t.Fatalf("expected SaveState once for bootstrap, got %d", docStore.saveStateCalls)
	}
}

func TestProjectedStateBuilderBuildProjectedState_WithPendingProposalsForUser(t *testing.T) {
	docID := uuid.New()
	userID := uuid.New()
	otherUserID := uuid.New()

	baseState := mustBuildDocState(t, "hello")
	proposalUpdate1 := buildAppendUpdate(t, baseState, " world")
	proposalUpdate2 := buildAppendUpdate(t, baseState, " from-other-user")

	docStore := &fakeProjectorStateStore{loadedState: baseState}
	proposalStore := &fakeProjectorProposalStore{
		listByDocument: []collabModels.Proposal{
			{
				ID:              uuid.New(),
				DocumentID:      docID,
				Status:          collabModels.ProposalStatusPending,
				YjsUpdate:       proposalUpdate1,
				CreatedByUserID: userID,
				CreatedAt:       time.Now().UTC(),
			},
			{
				ID:              uuid.New(),
				DocumentID:      docID,
				Status:          collabModels.ProposalStatusPending,
				YjsUpdate:       proposalUpdate2,
				CreatedByUserID: otherUserID,
				CreatedAt:       time.Now().UTC().Add(1 * time.Minute),
			},
		},
	}
	runtime := &fakeProjectorRuntime{found: false}

	builder := &ProjectedStateBuilderService{
		stateStore:      docStore,
		proposalStore:   proposalStore,
		proposalRuntime: runtime,
		contentLoader:   &fakeContentLoader{},
	}

	state, err := builder.BuildProjectedState(context.Background(), docID, userID)
	if err != nil {
		t.Fatalf("BuildProjectedState: %v", err)
	}

	got := decodeDocContent(t, state)
	if got != "hello world" {
		t.Errorf("expected projected content %q, got %q", "hello world", got)
	}

	// Should NOT persist (no bootstrap needed)
	if docStore.saveStateCalls != 0 {
		t.Fatalf("expected no SaveState call (no bootstrap), got %d", docStore.saveStateCalls)
	}
}

type fakeProjectorRuntime struct {
	snapshot []byte
	found    bool
	err      error
}

func (r *fakeProjectorRuntime) ApplyUpdate(_ context.Context, _ uuid.UUID, _ []byte, _ string) error {
	return nil
}

func (r *fakeProjectorRuntime) GetStateSnapshot(_ context.Context, _ uuid.UUID) ([]byte, bool, error) {
	if r.err != nil {
		return nil, false, r.err
	}
	return r.snapshot, r.found, nil
}

func (r *fakeProjectorRuntime) GetCurrentState(_ context.Context, _ uuid.UUID) ([]byte, error) {
	if r.err != nil {
		return nil, r.err
	}
	return r.snapshot, nil
}

type fakeProjectorStateStore struct {
	loadedState []byte

	loadStateCalls int
	saveStateCalls int

	savedDocID   string
	savedState   []byte
	savedContent string
}

func (s *fakeProjectorStateStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	s.loadStateCalls++
	return s.loadedState, nil
}

func (s *fakeProjectorStateStore) SaveState(
	_ context.Context,
	docID string,
	state []byte,
	content string,
) error {
	s.saveStateCalls++
	s.savedDocID = docID
	s.savedState = state
	s.savedContent = content
	return nil
}

type fakeProjectorProposalStore struct {
	listByDocument []collabModels.Proposal
}

func (s *fakeProjectorProposalStore) Create(_ context.Context, _ *collabModels.Proposal) error {
	return nil
}

func (s *fakeProjectorProposalStore) GetByID(_ context.Context, _ uuid.UUID) (*collabModels.Proposal, error) {
	return nil, nil
}

func (s *fakeProjectorProposalStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ collabModels.ProposalSource,
) (int, error) {
	return 0, nil
}

func (s *fakeProjectorProposalStore) ListByDocument(
	_ context.Context,
	_ uuid.UUID,
	_ *collabModels.ProposalStatus,
	_, _ int,
) ([]collabModels.Proposal, error) {
	return s.listByDocument, nil
}

func (s *fakeProjectorProposalStore) ListByGroup(
	_ context.Context,
	_ uuid.UUID,
	_ *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	return nil, nil
}

func (s *fakeProjectorProposalStore) MarkAccepted(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *fakeProjectorProposalStore) MarkRejected(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}

func (s *fakeProjectorProposalStore) UpsertStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus) error {
	return nil
}

func (s *fakeProjectorProposalStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}

func (s *fakeProjectorProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
}

type fakeContentLoader struct {
	content string
}

func (l *fakeContentLoader) LoadContentForBootstrap(_ context.Context, _ string) (string, error) {
	return l.content, nil
}

func buildAppendUpdate(t *testing.T, baseState []byte, suffix string) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("proposal", true, ycrdt.DefaultGCFilter, nil, false)
	ycrdt.ApplyUpdate(doc, baseState, "base")
	text := doc.GetText("content")
	sv := ycrdt.EncodeStateVector(doc, nil, ycrdt.NewUpdateEncoderV1())
	doc.Transact(func(_ *ycrdt.Transaction) {
		text.Insert(text.Length(), suffix, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, sv)
}

func mustBuildDocState(t *testing.T, content string) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("test-doc", true, ycrdt.DefaultGCFilter, nil, false)
	yText := doc.GetText("content")
	doc.Transact(func(_ *ycrdt.Transaction) {
		yText.Insert(0, content, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

func decodeDocContent(t *testing.T, state []byte) string {
	t.Helper()
	doc := ycrdt.NewDoc("decode-doc", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, "decode"); err != nil {
			t.Fatalf("decode apply state: %v", err)
		}
	}
	text := doc.GetText("content")
	if text == nil {
		return ""
	}
	return text.ToString()
}

func applyStateSequenceToContent(t *testing.T, states ...[]byte) string {
	t.Helper()
	doc := ycrdt.NewDoc("sequence-doc", true, ycrdt.DefaultGCFilter, nil, false)
	for _, state := range states {
		if len(state) == 0 {
			continue
		}
		if err := safeApplyUpdate(doc, state, "sequence"); err != nil {
			t.Fatalf("apply state sequence: %v", err)
		}
	}

	text := doc.GetText("content")
	if text == nil {
		return ""
	}
	return text.ToString()
}
