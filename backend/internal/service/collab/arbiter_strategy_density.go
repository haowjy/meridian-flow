package collab

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// RecentChangeDensityStrategy flags documents with high recent proposal volume.
// When many AI proposals are accepted for the same document in a short window,
// the combined semantic result is more likely to be incoherent, so review is required.
type RecentChangeDensityStrategy struct {
	store          collabSvc.ProposalStore
	threshold      int
	lookbackWindow time.Duration
	logger         *slog.Logger
}

// NewRecentChangeDensityStrategy creates a density-based arbiter strategy.
// threshold is the max number of recently accepted proposals before review is required.
// lookbackWindow is how far back to count accepted proposals.
func NewRecentChangeDensityStrategy(
	store collabSvc.ProposalStore,
	threshold int,
	lookbackWindow time.Duration,
	logger *slog.Logger,
) *RecentChangeDensityStrategy {
	return &RecentChangeDensityStrategy{
		store:          store,
		threshold:      threshold,
		lookbackWindow: lookbackWindow,
		logger:         logger,
	}
}

func (s *RecentChangeDensityStrategy) Name() string { return "recent_change_density" }

func (s *RecentChangeDensityStrategy) Evaluate(ctx context.Context, input collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	since := time.Now().Add(-s.lookbackWindow)
	count, err := s.store.CountRecentByDocumentAndStatus(
		ctx,
		input.DocumentID,
		collabModels.ProposalStatusAccepted,
		since,
	)
	if err != nil {
		// Fail-safe: if we can't query density, require review.
		s.logger.Error("density strategy store error, failing safe to require_review",
			"error", err,
			"document_id", input.DocumentID,
		)
		return collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictRequireReview,
			Reason:  fmt.Sprintf("density check failed (store error): %v", err),
		}
	}

	if count >= s.threshold {
		return collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictRequireReview,
			Reason:  fmt.Sprintf("recent accepted density %d >= threshold %d for document", count, s.threshold),
		}
	}

	return collabSvc.ArbiterDecision{
		Verdict: collabSvc.ArbiterVerdictPassThrough,
		Reason:  fmt.Sprintf("recent accepted density %d below threshold %d", count, s.threshold),
	}
}
