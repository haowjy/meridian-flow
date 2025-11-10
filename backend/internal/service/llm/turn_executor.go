package llm

import (
	"context"
	"fmt"
	"sync"
	"time"

	"meridian/internal/domain/models/llm"
	domainllm "meridian/internal/domain/services/llm"
	llmrepo "meridian/internal/domain/repositories/llm"
)

// TurnExecutor orchestrates streaming execution for a single turn.
//
// Responsibilities:
//   - Coordinate provider streaming
//   - Accumulate deltas into TurnBlocks via BlockAccumulator
//   - Broadcast SSE events to all connected clients
//   - Handle context cancellation (interruption)
//   - Update turn status and metadata in database
//   - Manage reconnection (catchup events)
//
// Thread-safety: Methods are thread-safe. Multiple SSE clients can connect concurrently.
type TurnExecutor struct {
	turnID   string
	model    string
	turnRepo llmrepo.TurnRepository
	provider domainllm.LLMProvider

	// Streaming state
	ctx        context.Context
	cancelFunc context.CancelFunc
	accumulator *BlockAccumulator

	// SSE client management
	clients   map[string]chan string // clientID -> event channel
	clientsMu sync.RWMutex

	// Streaming status
	status     string // "streaming", "complete", "error", "cancelled"
	statusMu   sync.RWMutex
	statusErr  error // Error if status = "error"

	// Metadata (populated when streaming completes)
	metadata   *domainllm.StreamMetadata
	metadataMu sync.RWMutex
}

// NewTurnExecutor creates a new TurnExecutor for a turn.
func NewTurnExecutor(
	parentCtx context.Context,
	turnID string,
	model string,
	turnRepo llmrepo.TurnRepository,
	provider domainllm.LLMProvider,
) *TurnExecutor {
	ctx, cancel := context.WithCancel(parentCtx)

	return &TurnExecutor{
		turnID:      turnID,
		model:       model,
		turnRepo:    turnRepo,
		provider:    provider,
		ctx:         ctx,
		cancelFunc:  cancel,
		accumulator: NewBlockAccumulator(turnID, turnRepo),
		clients:     make(map[string]chan string),
		status:      "streaming",
	}
}

// Start begins streaming execution (non-blocking).
// Spawns a goroutine that streams from provider, accumulates blocks, and broadcasts events.
func (e *TurnExecutor) Start(req *domainllm.GenerateRequest) {
	go e.executeStreaming(req)
}

// AddClient registers a new SSE client for this turn.
// Returns a channel that receives SSE-formatted event strings.
// Client should read from channel until it closes.
func (e *TurnExecutor) AddClient(clientID string) <-chan string {
	e.clientsMu.Lock()
	defer e.clientsMu.Unlock()

	// Create buffered channel to prevent blocking
	eventChan := make(chan string, 20)
	e.clients[clientID] = eventChan

	return eventChan
}

// RemoveClient unregisters an SSE client.
func (e *TurnExecutor) RemoveClient(clientID string) {
	e.clientsMu.Lock()
	defer e.clientsMu.Unlock()

	if ch, exists := e.clients[clientID]; exists {
		close(ch)
		delete(e.clients, clientID)
	}
}

// GetClientChannel returns the bidirectional channel for a client.
// Used for sending catchup events during reconnection.
// Returns nil if client doesn't exist.
func (e *TurnExecutor) GetClientChannel(clientID string) chan string {
	e.clientsMu.RLock()
	defer e.clientsMu.RUnlock()

	return e.clients[clientID]
}

// Interrupt cancels the streaming turn.
// Safe to call multiple times.
func (e *TurnExecutor) Interrupt() {
	e.cancelFunc()

	e.statusMu.Lock()
	if e.status == "streaming" {
		e.status = "cancelled"
	}
	e.statusMu.Unlock()
}

// GetStatus returns the current execution status.
// Returns: "streaming", "complete", "error", "cancelled"
func (e *TurnExecutor) GetStatus() string {
	e.statusMu.RLock()
	defer e.statusMu.RUnlock()
	return e.status
}

// GetError returns the error if status is "error", nil otherwise.
func (e *TurnExecutor) GetError() error {
	e.statusMu.RLock()
	defer e.statusMu.RUnlock()
	return e.statusErr
}

// GetMetadata returns the final stream metadata (available after completion).
func (e *TurnExecutor) GetMetadata() *domainllm.StreamMetadata {
	e.metadataMu.RLock()
	defer e.metadataMu.RUnlock()
	return e.metadata
}

// HandleReconnection sends catchup events to a newly connected client.
// Sends all completed blocks + current partial block (if any).
func (e *TurnExecutor) HandleReconnection(ctx context.Context, clientChan chan<- string) error {
	// Get all completed blocks from database
	blocks, err := e.turnRepo.GetTurnBlocks(ctx, e.turnID)
	if err != nil {
		return fmt.Errorf("failed to fetch turn blocks: %w", err)
	}

	// Send completed blocks as catchup events
	for _, block := range blocks {
		event, err := llm.NewBlockCatchupEvent(&block)
		if err != nil {
			return fmt.Errorf("failed to create catchup event: %w", err)
		}

		select {
		case clientChan <- event:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// Send current partial block if streaming in progress
	e.statusMu.RLock()
	status := e.status
	e.statusMu.RUnlock()

	if status == "streaming" {
		currentBlock := e.accumulator.GetCurrentBlock()
		if currentBlock != nil {
			event, err := llm.NewBlockCatchupEvent(currentBlock)
			if err != nil {
				return fmt.Errorf("failed to create current block catchup event: %w", err)
			}

			select {
			case clientChan <- event:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	} else if status == "complete" {
		// Turn already completed - send turn_complete event and close channel
		metadata := e.GetMetadata()
		if metadata != nil {
			event, err := llm.NewTurnCompleteEvent(
				e.turnID,
				metadata.StopReason,
				metadata.InputTokens,
				metadata.OutputTokens,
				metadata.ResponseMetadata,
			)
			if err != nil {
				return fmt.Errorf("failed to create turn complete event: %w", err)
			}

			select {
			case clientChan <- event:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		// Close channel so SSE connection ends gracefully
		close(clientChan)
	} else if status == "error" {
		// Turn errored - send turn_error event and close channel
		statusErr := e.GetError()
		errorMsg := "unknown error"
		if statusErr != nil {
			errorMsg = statusErr.Error()
		}

		event, err := llm.NewTurnErrorEvent(e.turnID, errorMsg, nil)
		if err != nil {
			return fmt.Errorf("failed to create turn error event: %w", err)
		}

		select {
		case clientChan <- event:
		case <-ctx.Done():
			return ctx.Err()
		}

		// Close channel so SSE connection ends gracefully
		close(clientChan)
	} else if status == "cancelled" {
		// Turn cancelled - send error event and close channel
		event, err := llm.NewTurnErrorEvent(e.turnID, "turn was cancelled", nil)
		if err != nil {
			return fmt.Errorf("failed to create cancellation event: %w", err)
		}

		select {
		case clientChan <- event:
		case <-ctx.Done():
			return ctx.Err()
		}

		// Close channel so SSE connection ends gracefully
		close(clientChan)
	}

	return nil
}

// executeStreaming is the main streaming loop (runs in goroutine).
func (e *TurnExecutor) executeStreaming(req *domainllm.GenerateRequest) {
	// Update turn status to "streaming"
	if err := e.turnRepo.UpdateTurnStatus(e.ctx, e.turnID, "streaming", nil); err != nil {
		e.handleError(fmt.Errorf("failed to update turn status: %w", err))
		return
	}

	// Send turn_start event
	startEvent, _ := llm.NewTurnStartEvent(e.turnID, e.model)
	e.broadcast(startEvent)

	// Start provider streaming
	streamChan, err := e.provider.StreamResponse(e.ctx, req)
	if err != nil {
		e.handleError(fmt.Errorf("failed to start provider streaming: %w", err))
		return
	}

	// Process streaming events
	var currentBlockIndex = -1

	for streamEvent := range streamChan {
		// Check for errors
		if streamEvent.Error != nil {
			e.handleError(streamEvent.Error)
			return
		}

		// Process delta
		if streamEvent.Delta != nil {
			if err := e.processDelta(streamEvent.Delta, &currentBlockIndex); err != nil {
				e.handleError(err)
				return
			}
		}

		// Process metadata (final event)
		if streamEvent.Metadata != nil {
			e.handleCompletion(streamEvent.Metadata)
			return
		}
	}

	// Stream channel closed without metadata - unexpected
	e.handleError(fmt.Errorf("stream closed without metadata"))
}

// processDelta handles a single TurnBlockDelta.
func (e *TurnExecutor) processDelta(delta *llm.TurnBlockDelta, currentBlockIndex *int) error {
	// Detect new block start
	if delta.BlockIndex != *currentBlockIndex {
		// Send block_start event
		blockStartEvent, _ := llm.NewBlockStartEvent(delta.BlockIndex, delta.BlockType)
		e.broadcast(blockStartEvent)

		*currentBlockIndex = delta.BlockIndex
	}

	// Send block_delta event
	deltaEvent, _ := llm.NewBlockDeltaEvent(delta)
	e.broadcast(deltaEvent)

	// Accumulate delta (may flush previous block to DB)
	flushedBlock, err := e.accumulator.ProcessDelta(e.ctx, delta)
	if err != nil {
		return fmt.Errorf("failed to process delta: %w", err)
	}

	// If a block was flushed, send block_stop event
	if flushedBlock != nil {
		blockStopEvent, _ := llm.NewBlockStopEvent(flushedBlock.Sequence)
		e.broadcast(blockStopEvent)
	}

	return nil
}

// handleCompletion handles successful stream completion.
func (e *TurnExecutor) handleCompletion(metadata *domainllm.StreamMetadata) {
	// Finalize accumulator (flush last block)
	lastBlock, err := e.accumulator.Finalize(e.ctx)
	if err != nil {
		e.handleError(fmt.Errorf("failed to finalize accumulator: %w", err))
		return
	}

	// Send block_stop for last block
	if lastBlock != nil {
		blockStopEvent, _ := llm.NewBlockStopEvent(lastBlock.Sequence)
		e.broadcast(blockStopEvent)
	}

	// Update turn with metadata
	if err := e.updateTurnMetadata(metadata); err != nil {
		e.handleError(fmt.Errorf("failed to update turn metadata: %w", err))
		return
	}

	// Store metadata
	e.metadataMu.Lock()
	e.metadata = metadata
	e.metadataMu.Unlock()

	// Update status
	e.statusMu.Lock()
	e.status = "complete"
	e.statusMu.Unlock()

	// Update turn status in database
	if err := e.turnRepo.UpdateTurnStatus(e.ctx, e.turnID, "complete", nil); err != nil {
		// Log error but don't fail (turn completed successfully)
		// TODO: Add structured logging
	}

	// Send turn_complete event
	completeEvent, _ := llm.NewTurnCompleteEvent(
		e.turnID,
		metadata.StopReason,
		metadata.InputTokens,
		metadata.OutputTokens,
		metadata.ResponseMetadata,
	)
	e.broadcast(completeEvent)

	// Close all client channels
	e.clientsMu.Lock()
	for clientID, ch := range e.clients {
		close(ch)
		delete(e.clients, clientID)
	}
	e.clientsMu.Unlock()
}

// handleError handles streaming errors.
func (e *TurnExecutor) handleError(err error) {
	// Finalize accumulator to save partial content
	lastBlock, _ := e.accumulator.Finalize(e.ctx)

	// Update status
	e.statusMu.Lock()
	e.status = "error"
	e.statusErr = err
	e.statusMu.Unlock()

	// Update turn status in database
	if updateErr := e.turnRepo.UpdateTurnError(e.ctx, e.turnID, err.Error()); updateErr != nil {
		// Log error but continue (main error is more important)
		// TODO: Add structured logging
	}

	// Determine last block index
	var lastBlockIndex *int
	if lastBlock != nil {
		idx := lastBlock.Sequence
		lastBlockIndex = &idx
	}

	// Send turn_error event
	errorEvent, _ := llm.NewTurnErrorEvent(e.turnID, err.Error(), lastBlockIndex)
	e.broadcast(errorEvent)

	// Close all client channels
	e.clientsMu.Lock()
	for clientID, ch := range e.clients {
		close(ch)
		delete(e.clients, clientID)
	}
	e.clientsMu.Unlock()
}

// broadcast sends an SSE event to all connected clients.
func (e *TurnExecutor) broadcast(event string) {
	e.clientsMu.RLock()
	defer e.clientsMu.RUnlock()

	for _, ch := range e.clients {
		select {
		case ch <- event:
			// Successfully sent
		default:
			// Client channel full, skip (client will reconnect for catchup)
			// TODO: Add structured logging
		}
	}
}

// updateTurnMetadata updates the turn with final metadata.
func (e *TurnExecutor) updateTurnMetadata(metadata *domainllm.StreamMetadata) error {
	// Update turn fields
	now := time.Now()

	return e.turnRepo.UpdateTurnMetadata(e.ctx, e.turnID, map[string]interface{}{
		"model":             metadata.Model,
		"input_tokens":      metadata.InputTokens,
		"output_tokens":     metadata.OutputTokens,
		"stop_reason":       metadata.StopReason,
		"response_metadata": metadata.ResponseMetadata,
		"completed_at":      now,
	})
}
