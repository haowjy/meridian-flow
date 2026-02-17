package collab

import (
	"context"
	"fmt"

	collabSvc "meridian/internal/domain/services/collab"
)

// SizeThresholdStrategy classifies proposals by Yjs update size.
// Large proposals (> largeThresholdBytes) require writer review;
// smaller proposals pass through to the next strategy or baseline.
type SizeThresholdStrategy struct {
	largeThresholdBytes int
}

// NewSizeThresholdStrategy creates a size-based arbiter strategy.
// largeThresholdBytes is the size above which proposals require writer review.
func NewSizeThresholdStrategy(largeThresholdBytes int) *SizeThresholdStrategy {
	return &SizeThresholdStrategy{
		largeThresholdBytes: largeThresholdBytes,
	}
}

func (s *SizeThresholdStrategy) Name() string { return "size_threshold" }

func (s *SizeThresholdStrategy) Evaluate(_ context.Context, input collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	if input.YjsUpdateSize > s.largeThresholdBytes {
		return collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictRequireReview,
			Reason:  fmt.Sprintf("proposal size %d bytes exceeds large threshold %d", input.YjsUpdateSize, s.largeThresholdBytes),
		}
	}
	return collabSvc.ArbiterDecision{
		Verdict: collabSvc.ArbiterVerdictPassThrough,
		Reason:  fmt.Sprintf("proposal size %d bytes within thresholds", input.YjsUpdateSize),
	}
}
