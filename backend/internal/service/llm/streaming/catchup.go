package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
)

// buildCatchupFunc creates a catchup function that retrieves events from the database.
// This function is used by mstream to replay missed events during reconnection or first connection.
// Uses TurnReader interface for better ISP compliance (only needs read operations)
//
// NOTE: Legacy block events have been removed - frontend now uses AG-UI protocol exclusively.
// Catchup only emits turn_start for basic reconnection support. The frontend handles
// block catchup via API queries when needed.
func buildCatchupFunc(turnRepo llmRepo.TurnReader, logger *slog.Logger) mstream.CatchupFunc {
	return func(streamID string, lastEventID string) ([]mstream.Event, error) {
		ctx := context.Background()
		turnID := streamID // streamID is the turnID

		// Get turn metadata for model info
		turn, err := turnRepo.GetTurn(ctx, turnID)
		if err != nil {
			logger.Error("failed to get turn for catchup",
				"turn_id", turnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to get turn: %w", err)
		}

		// Convert to mstream.Events
		var events []mstream.Event

		// Emit turn_start (basic reconnection support)
		// Library will add event IDs if DEBUG mode enabled
		model := ""
		if turn.Model != nil {
			model = *turn.Model
		}
		turnStartData, _ := json.Marshal(llmModels.TurnStartEvent{
			TurnID: turnID,
			Model:  model,
		})
		events = append(events, mstream.NewEvent(turnStartData).
			WithType(llmModels.SSEEventTurnStart))

		return events, nil
	}
}
