package collab

import (
	"context"
	"fmt"

	collabSvc "meridian/internal/domain/services/collab"
)

const (
	defaultSmallThresholdBytes = 1024      // 1 KB
	defaultLargeThresholdBytes = 50 * 1024 // 50 KB
)

// SizeThresholdStrategy classifies proposals by Yjs update size.
// Large proposals (> largeThresholdBytes) require writer review;
// small/medium proposals pass through to the next strategy or baseline.
type SizeThresholdStrategy struct {
	smallThresholdBytes int
	largeThresholdBytes int
}

// NewSizeThresholdStrategy creates a size-based arbiter strategy.
// smallThresholdBytes and largeThresholdBytes define the classification bands.
func NewSizeThresholdStrategy(smallThresholdBytes, largeThresholdBytes int) *SizeThresholdStrategy {
	return &SizeThresholdStrategy{
		smallThresholdBytes: smallThresholdBytes,
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
