package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/streaming/agui"
)

// buildCatchupFunc creates a catchup function that retrieves events from the database.
// This function is used by mstream to replay missed events during reconnection or first connection.
// Uses TurnReader interface for better ISP compliance (only needs read operations)
//
// Catchup emits RUN_STARTED with lastBlockSequence for reconnection support:
// - lastBlockSequence tells the frontend where to start indexing new blocks
// - Frontend fetches existing blocks via REST API, then continues from lastBlockSequence+1
// - This prevents duplicate/out-of-order blocks on reconnection
func buildCatchupFunc(turnWriter domainllm.TurnReader, logger *slog.Logger) mstream.CatchupFunc {
	return func(streamID string, lastEventID string) ([]mstream.Event, error) {
		ctx := context.Background()
		turnID := streamID // streamID is the turnID

		// Get turn metadata for thread ID
		turn, err := turnWriter.GetTurn(ctx, turnID)
		if err != nil {
			logger.Error("failed to get turn for catchup",
				"turn_id", turnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to get turn: %w", err)
		}

		// Get last block sequence for reconnection support
		// This tells the frontend where to start indexing new blocks
		lastBlockSeq, err := turnWriter.GetLastBlockSequence(ctx, turnID)
		if err != nil {
			logger.Warn("failed to get last block sequence for catchup, continuing without it",
				"turn_id", turnID,
				"error", err,
			)
			// Continue without lastBlockSequence - behaves like first connection
			lastBlockSeq = -1
		}

		// Convert to mstream.Events
		var events []mstream.Event

		// Emit RUN_STARTED with lastBlockSequence for reconnection support
		// Only include lastBlockSequence if blocks exist (>= 0)
		var lastBlockSeqPtr *int
		if lastBlockSeq >= 0 {
			lastBlockSeqPtr = &lastBlockSeq
		}

		// runID follows AG-UI convention: "run_{turnId}"
		runID := "run_" + turnID
		runStarted := agui.NewMeridianRunStartedEvent(turn.ThreadID, runID, turnID, lastBlockSeqPtr)
		runStartedData, _ := json.Marshal(runStarted)
		events = append(events, mstream.NewEvent(runStartedData).
			WithType(string(runStarted.Type)))

		logger.Debug("catchup: emitting RUN_STARTED",
			"turn_id", turnID,
			"thread_id", turn.ThreadID,
			"last_block_sequence", lastBlockSeq,
		)

		return events, nil
	}
}
