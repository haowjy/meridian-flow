package collab

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	collab "meridian/internal/domain/collab"
)

func TestBuildProjectedStateParity_KnownExpectedText(t *testing.T) {
	docID := uuid.New()
	userID := uuid.New()
	otherUserID := uuid.New()

	baseState := mustBuildDocState(t, "hello")
	update1 := buildAppendUpdate(t, baseState, " one")
	stateAfterUpdate1 := applyStateToState(t, baseState, update1)
	update2 := buildAppendUpdate(t, stateAfterUpdate1, " two")
	otherUserUpdate := buildAppendUpdate(t, baseState, " other")

	now := time.Now().UTC()
	proposalStore := &fakeProjectorProposalStore{listByDocument: []collab.Proposal{
		{
			ID:              uuid.New(),
			DocumentID:      docID,
			Status:          collab.ProposalStatusPending,
			YjsUpdate:       update2,
			CreatedByUserID: userID,
			CreatedAt:       now.Add(2 * time.Minute),
		},
		{
			ID:              uuid.New(),
			DocumentID:      docID,
			Status:          collab.ProposalStatusPending,
			YjsUpdate:       otherUserUpdate,
			CreatedByUserID: otherUserID,
			CreatedAt:       now.Add(1 * time.Minute),
		},
		{
			ID:              uuid.New(),
			DocumentID:      docID,
			Status:          collab.ProposalStatusPending,
			YjsUpdate:       update1,
			CreatedByUserID: userID,
			CreatedAt:       now.Add(1 * time.Minute),
		},
	}}

	builder := NewProjectedStateBuilder(
		&fakeProjectorStateStore{loadedState: baseState},
		proposalStore,
		&fakeProjectorRuntime{snapshot: baseState, found: true},
		&fakeContentLoader{},
	)

	projectedState, err := builder.BuildProjectedState(context.Background(), docID, userID)
	if err != nil {
		t.Fatalf("BuildProjectedState: %v", err)
	}

	got := decodeDocContent(t, projectedState)
	want := applyStateSequenceToContent(t, baseState, update1, update2)
	if got != want {
		t.Fatalf("projection parity mismatch: want %q, got %q", want, got)
	}
}

func applyStateToState(t *testing.T, baseState []byte, update []byte) []byte {
	t.Helper()
	return mustEncodeStateFromSequence(t, baseState, update)
}

func mustEncodeStateFromSequence(t *testing.T, states ...[]byte) []byte {
	t.Helper()
	doc := mustBuildDocFromStates(t, states...)
	state, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		t.Fatalf("encode state: %v", err)
	}
	return state
}

func mustBuildDocFromStates(t *testing.T, states ...[]byte) *ycrdt.Doc {
	t.Helper()
	doc := ycrdt.NewDoc("parity-seq", true, ycrdt.DefaultGCFilter, nil, false)
	for _, state := range states {
		if len(state) == 0 {
			continue
		}
		if err := safeApplyUpdate(doc, state, "parity-seq"); err != nil {
			t.Fatalf("apply state: %v", err)
		}
	}
	return doc
}
