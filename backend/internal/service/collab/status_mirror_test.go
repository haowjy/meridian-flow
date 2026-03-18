package collab

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
)

func TestStatusMirrorOnStatusChange_DeleteMapsToPending(t *testing.T) {
	docID := uuid.New()
	proposalID := uuid.New()
	store := &fakeStatusMirrorProposalStore{
		proposals: map[uuid.UUID]collabModels.Proposal{
			proposalID: {
				ID:         proposalID,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusRejected,
			},
		},
	}
	mirror := NewStatusMirror(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := mirror.OnStatusChange(context.Background(), proposalID.String(), nil); err != nil {
		t.Fatalf("OnStatusChange returned error: %v", err)
	}

	got, err := store.GetByID(context.Background(), proposalID)
	if err != nil {
		t.Fatalf("load proposal after mirror update: %v", err)
	}
	if got.Status != collabModels.ProposalStatusPending {
		t.Fatalf("expected pending after delete, got %s", got.Status)
	}
}

func TestStatusMirrorOnStatusChange_MissingProposalIsNonFatal(t *testing.T) {
	store := &fakeStatusMirrorProposalStore{proposals: map[uuid.UUID]collabModels.Proposal{}}
	mirror := NewStatusMirror(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	status := "accepted"
	if err := mirror.OnStatusChange(context.Background(), uuid.New().String(), &status); err != nil {
		t.Fatalf("OnStatusChange should skip missing proposal without error, got: %v", err)
	}
	if len(store.upserts) != 0 {
		t.Fatalf("expected no status upserts for missing proposal, got %d", len(store.upserts))
	}
}

func TestStatusMirrorReconcileAll_RepairsDriftAndSkipsInvalidMissingKey(t *testing.T) {
	docID := uuid.New()
	pAccepted := uuid.New()
	pRejected := uuid.New()
	pStale := uuid.New()
	pReverted := uuid.New()
	pMissing := uuid.New()
	pInvalidMissing := uuid.New()

	store := &fakeStatusMirrorProposalStore{
		proposals: map[uuid.UUID]collabModels.Proposal{
			pAccepted: {
				ID:         pAccepted,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusPending,
			},
			pRejected: {
				ID:         pRejected,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusAccepted,
			},
			pStale: {
				ID:         pStale,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusPending,
			},
			pReverted: {
				ID:         pReverted,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusPending,
			},
			pMissing: {
				ID:         pMissing,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusStale,
			},
			pInvalidMissing: {
				ID:         pInvalidMissing,
				DocumentID: docID,
				Status:     collabModels.ProposalStatusInvalid,
			},
		},
	}

	mirror := NewStatusMirror(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	statusMap := map[string]string{
		pAccepted.String(): "accepted",
		pRejected.String(): "rejected",
		pStale.String():    "stale",
		pReverted.String(): "reverted",
	}

	if err := mirror.ReconcileAll(context.Background(), docID.String(), statusMap); err != nil {
		t.Fatalf("ReconcileAll returned error: %v", err)
	}

	assertProposalStatus(t, store, pAccepted, collabModels.ProposalStatusAccepted)
	assertProposalStatus(t, store, pRejected, collabModels.ProposalStatusRejected)
	assertProposalStatus(t, store, pStale, collabModels.ProposalStatusStale)
	assertProposalStatus(t, store, pReverted, collabModels.ProposalStatusReverted)
	assertProposalStatus(t, store, pMissing, collabModels.ProposalStatusPending)
	assertProposalStatus(t, store, pInvalidMissing, collabModels.ProposalStatusInvalid)
}

func assertProposalStatus(
	t *testing.T,
	store *fakeStatusMirrorProposalStore,
	proposalID uuid.UUID,
	want collabModels.ProposalStatus,
) {
	t.Helper()
	proposal, err := store.GetByID(context.Background(), proposalID)
	if err != nil {
		t.Fatalf("GetByID(%s): %v", proposalID, err)
	}
	if proposal.Status != want {
		t.Fatalf("proposal %s status: got %s, want %s", proposalID, proposal.Status, want)
	}
}

type fakeStatusMirrorProposalStore struct {
	proposals map[uuid.UUID]collabModels.Proposal
	upserts   []statusUpsertCall
}

type statusUpsertCall struct {
	proposalID uuid.UUID
	status     collabModels.ProposalStatus
}

func (s *fakeStatusMirrorProposalStore) Create(_ context.Context, proposal *collabModels.Proposal) error {
	s.proposals[proposal.ID] = *proposal
	return nil
}

func (s *fakeStatusMirrorProposalStore) GetByID(_ context.Context, proposalID uuid.UUID) (*collabModels.Proposal, error) {
	proposal, ok := s.proposals[proposalID]
	if !ok {
		return nil, collabProposalNotFound(proposalID)
	}
	copy := proposal
	return &copy, nil
}

func (s *fakeStatusMirrorProposalStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ collabModels.ProposalSource,
) (int, error) {
	return 0, nil
}

func (s *fakeStatusMirrorProposalStore) CountByDocumentAndTurnID(_ context.Context, _ uuid.UUID, _ uuid.UUID) (int, error) {
	return 0, nil
}

func (s *fakeStatusMirrorProposalStore) ListByDocument(
	_ context.Context,
	documentID uuid.UUID,
	_ *collabModels.ProposalStatus,
	limit int,
	offset int,
) ([]collabModels.Proposal, error) {
	matching := make([]collabModels.Proposal, 0, len(s.proposals))
	for _, proposal := range s.proposals {
		if proposal.DocumentID == documentID {
			matching = append(matching, proposal)
		}
	}

	if offset >= len(matching) {
		return nil, nil
	}
	end := offset + limit
	if end > len(matching) {
		end = len(matching)
	}
	return matching[offset:end], nil
}

func (s *fakeStatusMirrorProposalStore) UpsertStatus(
	_ context.Context,
	proposalID uuid.UUID,
	status collabModels.ProposalStatus,
) error {
	proposal, ok := s.proposals[proposalID]
	if !ok {
		return collabProposalNotFound(proposalID)
	}
	proposal.Status = status
	s.proposals[proposalID] = proposal
	s.upserts = append(s.upserts, statusUpsertCall{proposalID: proposalID, status: status})
	return nil
}

func (s *fakeStatusMirrorProposalStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}

func (s *fakeStatusMirrorProposalStore) CountRecentByDocumentAndStatus(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ time.Time,
) (int, error) {
	return 0, nil
}

func collabProposalNotFound(proposalID uuid.UUID) error {
	return domain.NewNotFoundError("proposal", fmt.Sprintf("proposal %s not found", proposalID))
}
