package collab

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
)

func TestAIContentProjectorListPendingProposals_DeterministicOrder(t *testing.T) {
	docID := uuid.New()
	now := time.Now().UTC()

	p3 := collabModels.Proposal{ID: uuid.MustParse("00000000-0000-0000-0000-000000000003"), DocumentID: docID, Status: collabModels.ProposalStatusProposed, CreatedAt: now.Add(3 * time.Minute)}
	p1 := collabModels.Proposal{ID: uuid.MustParse("00000000-0000-0000-0000-000000000001"), DocumentID: docID, Status: collabModels.ProposalStatusProposed, CreatedAt: now.Add(1 * time.Minute)}
	p2 := collabModels.Proposal{ID: uuid.MustParse("00000000-0000-0000-0000-000000000002"), DocumentID: docID, Status: collabModels.ProposalStatusProposed, CreatedAt: now.Add(2 * time.Minute)}

	projector := &AIContentProjector{
		documentStore:   &fakeProjectorDocumentStore{},
		proposalStore:   &fakeProjectorProposalStore{listByDocument: []collabModels.Proposal{p3, p1, p2}},
		proposalRuntime: &fakeProjectorRuntime{},
	}

	got, err := projector.listPendingProposals(context.Background(), docID)
	if err != nil {
		t.Fatalf("listPendingProposals: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 proposals, got %d", len(got))
	}
	if got[0].ID != p1.ID || got[1].ID != p2.ID || got[2].ID != p3.ID {
		t.Fatalf("unexpected proposal order: %s, %s, %s", got[0].ID, got[1].ID, got[2].ID)
	}
}

func TestAIContentProjectorRecompute_UsesInMemorySnapshotAndPendingProposals(t *testing.T) {
	docID := uuid.New()
	baseState := mustBuildDocState(t, "hello")
	updatedState := mustBuildDocState(t, "hello world")
	expectedAIContent := applyStateSequenceToContent(t, baseState, updatedState)

	docStore := &fakeProjectorDocumentStore{}
	proposalStore := &fakeProjectorProposalStore{
		listByDocument: []collabModels.Proposal{
			{
				ID:         uuid.New(),
				DocumentID: docID,
				Status:     collabModels.ProposalStatusProposed,
				YjsUpdate:  updatedState,
				CreatedAt:  time.Now().UTC(),
			},
		},
	}
	runtime := &fakeProjectorRuntime{snapshot: baseState, found: true}
	projector := NewAIContentProjector(docStore, proposalStore, runtime)

	if err := projector.Recompute(context.Background(), docID); err != nil {
		t.Fatalf("recompute: %v", err)
	}

	if docStore.loadStateCalls != 0 {
		t.Fatalf("expected no persisted LoadState call, got %d", docStore.loadStateCalls)
	}
	if docStore.saveStateCalls != 1 {
		t.Fatalf("expected one SaveState call, got %d", docStore.saveStateCalls)
	}
	if docStore.savedDocID != docID.String() {
		t.Fatalf("expected saved doc id %s, got %s", docID, docStore.savedDocID)
	}
	if docStore.savedContent != "hello" {
		t.Fatalf("expected base content 'hello', got %q", docStore.savedContent)
	}
	if docStore.savedAIContent != expectedAIContent {
		t.Fatalf("expected ai content %q, got %q", expectedAIContent, docStore.savedAIContent)
	}
	if got := decodeDocContent(t, docStore.savedState); got != "hello" {
		t.Fatalf("expected saved yjs_state content 'hello', got %q", got)
	}
}

func TestAIContentProjectorRecompute_FallsBackToPersistedState(t *testing.T) {
	docID := uuid.New()
	baseState := mustBuildDocState(t, "persisted")

	docStore := &fakeProjectorDocumentStore{loadedState: baseState}
	proposalStore := &fakeProjectorProposalStore{}
	runtime := &fakeProjectorRuntime{found: false}
	projector := NewAIContentProjector(docStore, proposalStore, runtime)

	if err := projector.Recompute(context.Background(), docID); err != nil {
		t.Fatalf("recompute: %v", err)
	}

	if docStore.loadStateCalls != 1 {
		t.Fatalf("expected one LoadState call, got %d", docStore.loadStateCalls)
	}
	if docStore.savedContent != "persisted" || docStore.savedAIContent != "persisted" {
		t.Fatalf("expected aligned content/ai_content from persisted base, got %q / %q", docStore.savedContent, docStore.savedAIContent)
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

type fakeProjectorDocumentStore struct {
	loadedState []byte

	loadStateCalls int
	saveStateCalls int

	savedDocID     string
	savedState     []byte
	savedContent   string
	savedAIContent string
}

func (s *fakeProjectorDocumentStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	s.loadStateCalls++
	return s.loadedState, nil
}

func (s *fakeProjectorDocumentStore) SaveState(
	_ context.Context,
	docID string,
	state []byte,
	content string,
	aiContent string,
) error {
	s.saveStateCalls++
	s.savedDocID = docID
	s.savedState = state
	s.savedContent = content
	s.savedAIContent = aiContent
	return nil
}

func (s *fakeProjectorDocumentStore) SaveSnapshot(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ *string,
	_ *string,
) (string, error) {
	return "", nil
}

func (s *fakeProjectorDocumentStore) ListSnapshots(
	_ context.Context,
	_ string,
	_, _ int,
) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}

func (s *fakeProjectorDocumentStore) GetSnapshot(_ context.Context, _ string) (*collabModels.SnapshotWithState, error) {
	return nil, nil
}

func (s *fakeProjectorDocumentStore) DeleteSnapshot(_ context.Context, _ string) error {
	return nil
}

func (s *fakeProjectorDocumentStore) DeleteExpiredAutoSnapshots(_ context.Context, _ int) (int64, error) {
	return 0, nil
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

func (s *fakeProjectorProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return 0, nil
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
