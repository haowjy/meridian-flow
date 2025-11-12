package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

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

		// Get all TurnBlocks from database
		blocks, err := turnRepo.GetTurnBlocks(ctx, turnID)
		if err != nil {
			logger.Error("failed to get turn blocks for catchup",
				"turn_id", turnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to get turn blocks: %w", err)
		}

		// Convert TurnBlocks to mstream.Events
		var events []mstream.Event
		eventSequence := 0

		for i, block := range blocks {
			// Send block_start event
			blockStartData, _ := json.Marshal(llmModels.BlockStartEvent{
				BlockIndex: i,
				BlockType:  block.BlockType,
			})
			events = append(events, mstream.NewEvent(blockStartData).
				WithType(llmModels.SSEEventBlockStart).
				WithID(fmt.Sprintf("event-%d", eventSequence)))
			eventSequence++

			// For completed blocks, send block_stop event
			// (We don't have deltas in DB, so we only send start/stop)
			blockStopData, _ := json.Marshal(llmModels.BlockStopEvent{
				BlockIndex: i,
			})
			events = append(events, mstream.NewEvent(blockStopData).
				WithType(llmModels.SSEEventBlockStop).
				WithID(fmt.Sprintf("event-%d", eventSequence)))
			eventSequence++
		}

		// Filter events after lastEventID if provided
		if lastEventID != "" {
			events = filterEventsAfter(events, lastEventID, logger)
		}

		logger.Debug("catchup events built",
			"turn_id", turnID,
			"last_event_id", lastEventID,
			"total_events", len(events),
		)

		return events, nil
	}
}

// filterEventsAfter filters events to only include those after lastEventID
func filterEventsAfter(events []mstream.Event, lastEventID string, logger *slog.Logger) []mstream.Event {
	// Parse lastEventID (format: "event-N")
	lastSeq := parseEventID(lastEventID)
	if lastSeq < 0 {
		logger.Warn("invalid last event ID format, returning all events",
			"last_event_id", lastEventID,
		)
		return events
	}

	// Filter events with sequence > lastSeq
	var filtered []mstream.Event
	for _, event := range events {
		eventSeq := parseEventID(event.ID)
		if eventSeq > lastSeq {
			filtered = append(filtered, event)
		}
	}

	return filtered
}

// parseEventID extracts the sequence number from an event ID (format: "event-N")
func parseEventID(eventID string) int {
	parts := strings.Split(eventID, "-")
	if len(parts) != 2 || parts[0] != "event" {
		return -1
	}

	seq, err := strconv.Atoi(parts[1])
	if err != nil {
		return -1
	}

	return seq
}
