package collab

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

func TestStrategyChainArbiter_SizeTriggersFirst(t *testing.T) {
	// Large proposal: size strategy should fire before density is reached.
	store := &stubProposalStore{count: 0}
	sizeStrategy := NewSizeThresholdStrategy(1024, 51200)
	densityStrategy := NewRecentChangeDensityStrategy(store, 5, time.Minute, slog.Default())
	arbiter := NewStrategyChainArbiter(
		[]ArbiterStrategy{sizeStrategy, densityStrategy},
		slog.Default(),
	)

	input := collabSvc.ArbiterInput{
		DocumentID:         uuid.New(),
		Source:             collabModels.ProposalSourceAI,
		YjsUpdateSize:      60000, // > 51200
		BaselineAutoAccept: true,
	}
	decision := arbiter.Evaluate(context.Background(), input)
	if decision.Verdict != collabSvc.ArbiterVerdictRequireReview {
		t.Fatalf("expected require_review from size strategy, got %q", decision.Verdict)
	}
}

func TestStrategyChainArbiter_SizePassesDensityTriggers(t *testing.T) {
	// Small proposal but high density: density strategy should trigger.
	store := &stubProposalStore{count: 10}
	sizeStrategy := NewSizeThresholdStrategy(1024, 51200)
	densityStrategy := NewRecentChangeDensityStrategy(store, 5, time.Minute, slog.Default())
	arbiter := NewStrategyChainArbiter(
		[]ArbiterStrategy{sizeStrategy, densityStrategy},
		slog.Default(),
	)

	input := collabSvc.ArbiterInput{
		DocumentID:         uuid.New(),
		Source:             collabModels.ProposalSourceAI,
		YjsUpdateSize:      512, // small
		BaselineAutoAccept: true,
	}
	decision := arbiter.Evaluate(context.Background(), input)
	if decision.Verdict != collabSvc.ArbiterVerdictRequireReview {
		t.Fatalf("expected require_review from density strategy, got %q", decision.Verdict)
	}
}

func TestStrategyChainArbiter_BothPassThrough(t *testing.T) {
	// Small proposal, low density: both strategies pass through.
	store := &stubProposalStore{count: 2}
	sizeStrategy := NewSizeThresholdStrategy(1024, 51200)
	densityStrategy := NewRecentChangeDensityStrategy(store, 5, time.Minute, slog.Default())
	arbiter := NewStrategyChainArbiter(
		[]ArbiterStrategy{sizeStrategy, densityStrategy},
		slog.Default(),
	)

	input := collabSvc.ArbiterInput{
		DocumentID:         uuid.New(),
		Source:             collabModels.ProposalSourceAI,
		YjsUpdateSize:      512,
		BaselineAutoAccept: true,
	}
	decision := arbiter.Evaluate(context.Background(), input)
	if decision.Verdict != collabSvc.ArbiterVerdictPassThrough {
		t.Fatalf("expected pass_through, got %q", decision.Verdict)
	}
}

func TestStrategyChainArbiter_EmptyChain(t *testing.T) {
	arbiter := NewStrategyChainArbiter(nil, slog.Default())
	input := collabSvc.ArbiterInput{
		DocumentID:    uuid.New(),
		Source:        collabModels.ProposalSourceAI,
		YjsUpdateSize: 100,
	}
	decision := arbiter.Evaluate(context.Background(), input)
	if decision.Verdict != collabSvc.ArbiterVerdictPassThrough {
		t.Fatalf("expected pass_through from empty chain, got %q", decision.Verdict)
	}
}
