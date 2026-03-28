package streaming

import (
	"context"

	mstream "github.com/haowjy/meridian-stream-go"
)

const (
	creditLimitedErrorMessage     = "insufficient credits"
	runStopReasonCreditsExhausted = "credits_exhausted"
)

// handleCreditsExhausted finalizes the run via a dedicated credit-limited path.
// This path intentionally does not use handleError, so clients get a graceful terminal state.
func (se *StreamExecutor) handleCreditsExhausted(ctx context.Context, send func(mstream.Event), requestIndex int, phase string) {
	_ = send
	_ = ctx
	se.Terminate(ReasonCreditsExhausted, TerminateOpts{
		RequestIndex: requestIndex,
		Phase:        phase,
	})
}
