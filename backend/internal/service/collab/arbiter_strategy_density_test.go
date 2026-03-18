package collab

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// stubProposalStore is a minimal fake for density strategy tests.
type stubProposalStore struct {
	count int
	err   error
}

func (s *stubProposalStore) Create(_ context.Context, _ *collabModels.Proposal) error { return nil }
func (s *stubProposalStore) GetByID(_ context.Context, _ uuid.UUID) (*collabModels.Proposal, error) {
	return nil, nil
}
func (s *stubProposalStore) CountByDocumentAndStatusAndSource(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ collabModels.ProposalSource) (int, error) {
	return 0, nil
}
func (s *stubProposalStore) ListByDocument(_ context.Context, _ uuid.UUID, _ *collabModels.ProposalStatus, _ int, _ int) ([]collabModels.Proposal, error) {
	return nil, nil
}
func (s *stubProposalStore) ListByGroup(_ context.Context, _ uuid.UUID, _ *collabModels.ProposalStatus) ([]collabModels.Proposal, error) {
	return nil, nil
}
func (s *stubProposalStore) MarkAccepted(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}
func (s *stubProposalStore) MarkRejected(_ context.Context, _ collabModels.ProposalDecision) error {
	return nil
}
func (s *stubProposalStore) UpsertStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus) error {
	return nil
}
func (s *stubProposalStore) SetAcceptedAtOffset(_ context.Context, _ uuid.UUID, _ int, _ int) error {
	return nil
}
func (s *stubProposalStore) CountRecentByDocumentAndStatus(_ context.Context, _ uuid.UUID, _ collabModels.ProposalStatus, _ time.Time) (int, error) {
	return s.count, s.err
}

func TestRecentChangeDensityStrategy_Name(t *testing.T) {
	s := NewRecentChangeDensityStrategy(&stubProposalStore{}, 5, time.Minute, slog.Default())
	if s.Name() != "recent_change_density" {
		t.Fatalf("expected name 'recent_change_density', got %q", s.Name())
	}
}

func TestRecentChangeDensityStrategy_Evaluate(t *testing.T) {
	logger := slog.Default()

	tests := []struct {
		name        string
		count       int
		err         error
		wantVerdict collabSvc.ArbiterVerdict
	}{
		{"below threshold passes through", 3, nil, collabSvc.ArbiterVerdictPassThrough},
		{"zero count passes through", 0, nil, collabSvc.ArbiterVerdictPassThrough},
		{"at threshold requires review", 5, nil, collabSvc.ArbiterVerdictRequireReview},
		{"above threshold requires review", 10, nil, collabSvc.ArbiterVerdictRequireReview},
		{"store error fails safe to require review", 0, errors.New("db down"), collabSvc.ArbiterVerdictRequireReview},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &stubProposalStore{count: tt.count, err: tt.err}
			s := NewRecentChangeDensityStrategy(store, 5, time.Minute, logger)
			input := collabSvc.ArbiterInput{
				DocumentID:    uuid.New(),
				Source:        collabModels.ProposalSourceAI,
				YjsUpdateSize: 100,
			}
			decision := s.Evaluate(context.Background(), input)
			if decision.Verdict != tt.wantVerdict {
				t.Errorf("count=%d err=%v: got verdict %q, want %q", tt.count, tt.err, decision.Verdict, tt.wantVerdict)
			}
		})
	}
}

func TestRecentChangeDensityStrategy_ZeroLookbackWindow(t *testing.T) {
	store := &stubProposalStore{count: 0}
	s := NewRecentChangeDensityStrategy(store, 5, 0, slog.Default())
	input := collabSvc.ArbiterInput{
		DocumentID:    uuid.New(),
		Source:        collabModels.ProposalSourceAI,
		YjsUpdateSize: 100,
	}
	decision := s.Evaluate(context.Background(), input)
	if decision.Verdict != collabSvc.ArbiterVerdictPassThrough {
		t.Errorf("expected pass_through with zero lookback and zero count, got %q", decision.Verdict)
	}
}

func TestRecentChangeDensityStrategy_ReasonContainsDensity(t *testing.T) {
	store := &stubProposalStore{count: 10}
	s := NewRecentChangeDensityStrategy(store, 5, time.Minute, slog.Default())
	input := collabSvc.ArbiterInput{
		DocumentID:    uuid.New(),
		Source:        collabModels.ProposalSourceAI,
		YjsUpdateSize: 100,
	}
	decision := s.Evaluate(context.Background(), input)
	if decision.Reason == "" {
		t.Error("expected non-empty reason for require_review verdict")
	}
}
