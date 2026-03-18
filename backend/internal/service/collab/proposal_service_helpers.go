package collab

import (
	"context"
	"fmt"
	"log/slog"
	collabSvc "meridian/internal/domain/services/collab"
)

// --- Auto-accept resolution ---

// resolveAutoAccept resolves the auto-accept decision from the tri-state cascade:
// agent override > project policy > user policy > service default.
func (s *ProposalService) resolveAutoAccept(agent *bool, inputs *collabSvc.AutoAcceptPolicyInputs) bool {
	if agent != nil {
		return *agent
	}
	if inputs != nil && inputs.Project != nil {
		return *inputs.Project
	}
	if inputs != nil && inputs.User != nil {
		return *inputs.User
	}
	return s.defaultAutoAcceptValue
}

// --- Arbiter evaluation ---

// evaluateArbiterSafe wraps arbiter evaluation with panic recovery.
// On any panic, degrades to require-review for writer safety.
func (s *ProposalService) evaluateArbiterSafe(ctx context.Context, input collabSvc.ArbiterInput) (decision collabSvc.ArbiterDecision) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("arbiter panicked, degrading to require-review",
				"panic", fmt.Sprintf("%v", r),
				"document_id", input.DocumentID,
			)
			decision = collabSvc.ArbiterDecision{
				Verdict: collabSvc.ArbiterVerdictRequireReview,
				Reason:  "arbiter panic recovery",
			}
		}
	}()
	return s.arbiter.Evaluate(ctx, input)
}
