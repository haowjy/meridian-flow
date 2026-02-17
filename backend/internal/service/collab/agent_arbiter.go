package collab

import (
	"context"
	"log/slog"

	collabSvc "meridian/internal/domain/services/collab"
)

// StrategyChainArbiter evaluates strategies in order; the first non-pass-through verdict wins.
// If all strategies pass through (or the chain is empty), the arbiter returns PassThrough
// which preserves the baseline auto-accept decision.
type StrategyChainArbiter struct {
	strategies []collabSvc.ArbiterStrategy
	logger     *slog.Logger
}

// NewStrategyChainArbiter creates an arbiter that applies strategies in order.
// An empty strategies slice creates a no-op arbiter (all proposals pass through).
func NewStrategyChainArbiter(strategies []collabSvc.ArbiterStrategy, logger *slog.Logger) *StrategyChainArbiter {
	return &StrategyChainArbiter{
		strategies: strategies,
		logger:     logger,
	}
}

// Evaluate runs each strategy in order. First non-pass-through verdict wins.
func (a *StrategyChainArbiter) Evaluate(ctx context.Context, input collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	for _, strategy := range a.strategies {
		decision := strategy.Evaluate(ctx, input)
		if decision.Verdict != collabSvc.ArbiterVerdictPassThrough {
			a.logger.Debug("arbiter strategy decided",
				"strategy", strategy.Name(),
				"verdict", decision.Verdict,
				"reason", decision.Reason,
				"document_id", input.DocumentID,
			)
			return decision
		}
	}
	return collabSvc.ArbiterDecision{
		Verdict: collabSvc.ArbiterVerdictPassThrough,
		Reason:  "no strategy overrode baseline",
	}
}

// NoOpArbiter always returns PassThrough. Used as the default when no strategies are configured.
var NoOpArbiter = &noOpArbiter{}

type noOpArbiter struct{}

func (n *noOpArbiter) Evaluate(_ context.Context, _ collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	return collabSvc.ArbiterDecision{
		Verdict: collabSvc.ArbiterVerdictPassThrough,
		Reason:  "no-op arbiter",
	}
}
