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
	stream      *mstream.Stream
	turnID      string
	model       string
	turnRepo    llmRepo.TurnRepository
	provider    domainllm.LLMProvider
	accumulator *BlockAccumulator
	logger      *slog.Logger
	req         *domainllm.GenerateRequest // Stored for WorkFunc to use
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
func NewStreamExecutor(
	turnID string,
	model string,
	turnRepo llmRepo.TurnRepository,
	provider domainllm.LLMProvider,
	logger *slog.Logger,
	debugMode bool,
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

	// Create mstream.Stream with WorkFunc, catchup support, and optional event IDs (DEBUG mode)
	stream := mstream.NewStream(
		turnID,
		se.workFunc,
		mstream.WithCatchup(catchupFunc),
		mstream.WithEventIDs(debugMode), // Enable event IDs only in DEBUG mode
	)
	se.stream = stream

	logger.Debug("stream executor created",
		"turn_id", turnID,
		"debug_mode", debugMode,
	)

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

	// NOTE: turn_start (event-0) is emitted by catchup function, not here
	// Live streaming starts with block events (event-1+)

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
		// FIRST: Flush old block (if one exists) and send block_stop BEFORE starting new block
		if *currentBlockIndex >= 0 {
			// Accumulate this delta (which triggers flush of old block when index changes)
			flushedBlock, err := se.accumulator.ProcessDelta(ctx, delta)
			if err != nil {
				return fmt.Errorf("failed to process delta during block transition: %w", err)
			}

			// Send block_stop for the old block
			if flushedBlock != nil {
				se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
					BlockIndex: flushedBlock.Sequence,
				})

				// Clear buffer atomically with catchup coordination
				// Note: Block already persisted by accumulator, so persist function is no-op
				if err := se.stream.PersistAndClear(func(events []mstream.Event) error {
					return nil // Already persisted to DB by accumulator
				}); err != nil {
					se.logger.Error("failed to clear buffer atomically",
						"error", err,
						"block_index", flushedBlock.Sequence,
					)
				}

				se.logger.Debug("cleared buffer after block flush",
					"block_index", flushedBlock.Sequence,
					"turn_id", se.turnID,
				)
			}
		}

		// THEN: Send block_start for new block
		se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
			BlockIndex: delta.BlockIndex,
			BlockType:  delta.BlockType,
		})

		*currentBlockIndex = delta.BlockIndex

		// Handle empty DeltaType (block start signal with no content)
		if delta.DeltaType == "" {
			se.logger.Debug("block start delta with no content, initializing accumulator",
				"block_index", delta.BlockIndex,
				"block_type", delta.BlockType,
			)
			// Don't send SSE event (no content), but accumulator must initialize the block
			_, err := se.accumulator.ProcessDelta(ctx, delta)
			if err != nil {
				return fmt.Errorf("failed to initialize block %d: %w", delta.BlockIndex, err)
			}
			return nil
		}

		// Send the first block_delta for new block (has content)
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex:     delta.BlockIndex,
			DeltaType:      delta.DeltaType,
			TextDelta:      delta.TextDelta,
			InputJSONDelta: delta.InputJSONDelta,
		})

		// Accumulate the delta
		_, err := se.accumulator.ProcessDelta(ctx, delta)
		if err != nil {
			return fmt.Errorf("failed to accumulate delta: %w", err)
		}

		return nil
	}

	// Same block - continue accumulating
	// Handle empty DeltaType (no content to broadcast, but still accumulate for state)
	if delta.DeltaType == "" {
		se.logger.Debug("delta with no content, accumulating state only",
			"block_index", delta.BlockIndex,
			"block_type", delta.BlockType,
		)
		// Don't send SSE event (no content), but accumulator needs to maintain state
		_, err := se.accumulator.ProcessDelta(ctx, delta)
		return err
	}

	// Send block_delta event
	se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
		BlockIndex:     delta.BlockIndex,
		DeltaType:      delta.DeltaType,
		TextDelta:      delta.TextDelta,
		InputJSONDelta: delta.InputJSONDelta,
	})

	// Accumulate delta (no flush since same block)
	_, err := se.accumulator.ProcessDelta(ctx, delta)
	if err != nil {
		return fmt.Errorf("failed to process delta: %w", err)
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

// sendEvent sends an event via mstream.
// Event IDs are automatically generated by the library when DEBUG mode is enabled.
func (se *StreamExecutor) sendEvent(send func(mstream.Event), eventType string, data interface{}) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		se.logger.Error("failed to marshal event data", "error", err, "event_type", eventType)
		return
	}

	// Create event with type - library will add event ID if DEBUG mode enabled
	event := mstream.NewEvent(jsonData).WithType(eventType)
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
