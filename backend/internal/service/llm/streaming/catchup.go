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
func buildCatchupFunc(turnRepo llmRepo.TurnRepository, logger *slog.Logger) mstream.CatchupFunc {
	return func(streamID string, lastEventID string) ([]mstream.Event, error) {
		ctx := context.Background()
		turnID := streamID // streamID is the turnID

		logger.Debug("building catchup events",
			"turn_id", turnID,
			"last_event_id", lastEventID,
		)

		// Get turn metadata for model info
		turn, err := turnRepo.GetTurn(ctx, turnID)
		if err != nil {
			logger.Error("failed to get turn for catchup",
				"turn_id", turnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to get turn: %w", err)
		}

		// Get all TurnBlocks from database
		blocks, err := turnRepo.GetTurnBlocks(ctx, turnID)
		if err != nil {
			logger.Error("failed to get turn blocks for catchup",
				"turn_id", turnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to get turn blocks: %w", err)
		}

		// Convert to mstream.Events
		var events []mstream.Event

		// ALWAYS emit turn_start (even if no blocks yet)
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

		// Emit block events with full content
		for i, block := range blocks {
			// Send block_start event
			blockStartData, _ := json.Marshal(llmModels.BlockStartEvent{
				BlockIndex: i,
				BlockType:  &block.BlockType,
			})
			events = append(events, mstream.NewEvent(blockStartData).
				WithType(llmModels.SSEEventBlockStart))

			// Send full block content as single delta
			// (Library will add event IDs if DEBUG mode enabled)
			if block.TextContent != nil && *block.TextContent != "" {
				blockDeltaData, _ := json.Marshal(llmModels.BlockDeltaEvent{
					BlockIndex:     i,
					DeltaType:      "text_delta",
					TextDelta:      block.TextContent,
					InputJSONDelta: nil,
				})
				events = append(events, mstream.NewEvent(blockDeltaData).
					WithType(llmModels.SSEEventBlockDelta))
			}

			// For blocks with structured content, send as input_json_delta
			if block.Content != nil {
				contentJSON, _ := json.Marshal(block.Content)
				contentStr := string(contentJSON)
				blockDeltaData, _ := json.Marshal(llmModels.BlockDeltaEvent{
					BlockIndex:     i,
					DeltaType:      "input_json_delta",
					TextDelta:      nil,
					InputJSONDelta: &contentStr,
				})
				events = append(events, mstream.NewEvent(blockDeltaData).
					WithType(llmModels.SSEEventBlockDelta))
			}

			// Send block_stop event
			blockStopData, _ := json.Marshal(llmModels.BlockStopEvent{
				BlockIndex: i,
			})
			events = append(events, mstream.NewEvent(blockStopData).
				WithType(llmModels.SSEEventBlockStop))
		}

		logger.Debug("catchup events built",
			"turn_id", turnID,
			"last_event_id", lastEventID,
			"total_events", len(events),
		)

		return events, nil
	}
}
