package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	domainllm "meridian/internal/domain/services/llm"
)

// StreamExecutor wraps mstream.Stream and manages LLM streaming for a turn.
// It adapts the existing TurnExecutor logic to work with mstream's architecture.
type StreamExecutor struct {
	stream        *mstream.Stream
	turnID        string
	model         string
	turnRepo      llmRepo.TurnRepository
	provider      domainllm.LLMProvider
	accumulator   *BlockAccumulator
	logger        *slog.Logger
	req           *domainllm.GenerateRequest // Stored for WorkFunc to use
	eventSequence int                        // Sequential event ID counter for Last-Event-ID tracking
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
func NewStreamExecutor(
	turnID string,
	model string,
	turnRepo llmRepo.TurnRepository,
	provider domainllm.LLMProvider,
	logger *slog.Logger,
) *StreamExecutor {
	se := &StreamExecutor{
		turnID:      turnID,
		model:       model,
		turnRepo:    turnRepo,
		provider:    provider,
		accumulator: NewBlockAccumulator(turnID, turnRepo),
		logger:      logger,
	}

	// Create catchup function for database-backed event replay
	catchupFunc := buildCatchupFunc(turnRepo, logger)

	// Create mstream.Stream with WorkFunc and catchup support
	stream := mstream.NewStream(turnID, se.workFunc, mstream.WithCatchup(catchupFunc))
	se.stream = stream

	return se
}

// GetStream returns the underlying mstream.Stream
func (se *StreamExecutor) GetStream() *mstream.Stream {
	return se.stream
}

// Start begins streaming execution
func (se *StreamExecutor) Start(req *domainllm.GenerateRequest) {
	// Store request for WorkFunc to use
	se.req = req

	// Start the stream
	se.stream.Start()
}

// workFunc is the mstream WorkFunc that performs the actual streaming
func (se *StreamExecutor) workFunc(ctx context.Context, send func(mstream.Event)) error {
	// Use the stored GenerateRequest
	req := se.req
	if req == nil {
		return fmt.Errorf("generate request not set")
	}

	// Update turn status to "streaming"
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "streaming", nil); err != nil {
		return fmt.Errorf("failed to update turn status: %w", err)
	}

	// Send turn_start event
	se.sendEvent(send, llmModels.SSEEventTurnStart, llmModels.TurnStartEvent{
		TurnID: se.turnID,
		Model:  se.model,
	})

	// Start provider streaming
	streamChan, err := se.provider.StreamResponse(ctx, req)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to start provider streaming: %w", err))
		return err
	}

	// Process streaming events
	var currentBlockIndex = -1

	for {
		select {
		case <-ctx.Done():
			// Context cancelled - handle graceful shutdown
			err := fmt.Errorf("streaming interrupted: %w", ctx.Err())
			se.handleError(ctx, send, err)
			return err

		case streamEvent, ok := <-streamChan:
			if !ok {
				// Stream channel closed without metadata - unexpected
				err := fmt.Errorf("stream closed without metadata")
				se.handleError(ctx, send, err)
				return err
			}

			// Check for errors
			if streamEvent.Error != nil {
				se.handleError(ctx, send, streamEvent.Error)
				return streamEvent.Error
			}

			// Process delta
			if streamEvent.Delta != nil {
				if err := se.processDelta(ctx, send, streamEvent.Delta, &currentBlockIndex); err != nil {
					se.handleError(ctx, send, err)
					return err
				}
			}

			// Process metadata (final event)
			if streamEvent.Metadata != nil {
				return se.handleCompletion(ctx, send, streamEvent.Metadata)
			}
		}
	}
}

// processDelta handles a single TurnBlockDelta
func (se *StreamExecutor) processDelta(ctx context.Context, send func(mstream.Event), delta *llmModels.TurnBlockDelta, currentBlockIndex *int) error {
	// Detect new block start
	if delta.BlockIndex != *currentBlockIndex {
		// Send block_start event
		se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
			BlockIndex: delta.BlockIndex,
			BlockType:  delta.BlockType,
		})

		*currentBlockIndex = delta.BlockIndex
	}

	// Send block_delta event
	se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
		BlockIndex:     delta.BlockIndex,
		DeltaType:      delta.DeltaType,
		TextDelta:      delta.TextDelta,
		InputJSONDelta: delta.InputJSONDelta,
	})

	// Accumulate delta (may flush previous block to DB)
	flushedBlock, err := se.accumulator.ProcessDelta(ctx, delta)
	if err != nil {
		return fmt.Errorf("failed to process delta: %w", err)
	}

	// If a block was flushed, send block_stop event
	if flushedBlock != nil {
		se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
			BlockIndex: flushedBlock.Sequence,
		})
	}

	return nil
}

// handleCompletion handles successful stream completion
func (se *StreamExecutor) handleCompletion(ctx context.Context, send func(mstream.Event), metadata *domainllm.StreamMetadata) error {
	// Finalize accumulator (flush last block)
	lastBlock, err := se.accumulator.Finalize(ctx)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to finalize accumulator: %w", err))
		return err
	}

	// Send block_stop for last block
	if lastBlock != nil {
		se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
			BlockIndex: lastBlock.Sequence,
		})
	}

	// Update turn with metadata
	if err := se.updateTurnMetadata(ctx, metadata); err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to update turn metadata: %w", err))
		return err
	}

	// Update turn status in database
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "complete", nil); err != nil {
		se.logger.Error("failed to update turn status to complete", "error", err)
	}

	// Send turn_complete event
	se.sendEvent(send, llmModels.SSEEventTurnComplete, llmModels.TurnCompleteEvent{
		TurnID:           se.turnID,
		StopReason:       metadata.StopReason,
		InputTokens:      metadata.InputTokens,
		OutputTokens:     metadata.OutputTokens,
		ResponseMetadata: metadata.ResponseMetadata,
	})

	return nil
}

// handleError handles streaming errors
func (se *StreamExecutor) handleError(ctx context.Context, send func(mstream.Event), err error) {
	// Finalize accumulator to save partial content
	lastBlock, _ := se.accumulator.Finalize(ctx)

	// Update turn status in database
	if updateErr := se.turnRepo.UpdateTurnError(ctx, se.turnID, err.Error()); updateErr != nil {
		se.logger.Error("failed to update turn error", "error", updateErr)
	}

	// Determine last block index
	var lastBlockIndex *int
	if lastBlock != nil {
		idx := lastBlock.Sequence
		lastBlockIndex = &idx
	}

	// Send turn_error event
	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:         se.turnID,
		Error:          err.Error(),
		LastBlockIndex: lastBlockIndex,
	})
}

// sendEvent sends an event via mstream with sequential ID for Last-Event-ID tracking
func (se *StreamExecutor) sendEvent(send func(mstream.Event), eventType string, data interface{}) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		se.logger.Error("failed to marshal event data", "error", err, "event_type", eventType)
		return
	}

	// Generate sequential event ID
	eventID := fmt.Sprintf("event-%d", se.eventSequence)
	se.eventSequence++

	event := mstream.NewEvent(jsonData).
		WithType(eventType).
		WithID(eventID)
	send(event)
}

// updateTurnMetadata updates the turn with final metadata
func (se *StreamExecutor) updateTurnMetadata(ctx context.Context, metadata *domainllm.StreamMetadata) error {
	return se.turnRepo.UpdateTurnMetadata(ctx, se.turnID, map[string]interface{}{
		"model":             metadata.Model,
		"input_tokens":      metadata.InputTokens,
		"output_tokens":     metadata.OutputTokens,
		"stop_reason":       metadata.StopReason,
		"response_metadata": metadata.ResponseMetadata,
	})
}
