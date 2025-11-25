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
	"meridian/internal/service/llm/tools"
)

// StreamExecutor wraps mstream.Stream and manages LLM streaming for a turn.
// It adapts the existing TurnExecutor logic to work with mstream's architecture.
// Complete blocks come from the library (already normalized), so no accumulation needed.
type StreamExecutor struct {
	stream   *mstream.Stream
	turnID   string
	model    string
	turnRepo llmRepo.TurnWriter // Only needs write operations (ISP compliance)
	provider domainllm.LLMProvider
	logger   *slog.Logger
	req      *domainllm.GenerateRequest // Stored for WorkFunc to use

	// Tool execution support
	toolRegistry     *tools.ToolRegistry
	turnNavigator    llmRepo.TurnNavigator     // For loading conversation path during continuation
	turnReader       llmRepo.TurnReader        // For loading turn blocks during continuation
	messageBuilder   domainllm.MessageBuilder  // For building messages from conversation history
	collectedTools   []tools.ToolCall          // tool_use blocks collected during streaming
	toolIteration    int                       // current tool round (0 = initial, 1+ = continuations)
	maxToolRounds    int                       // maximum number of tool execution rounds (default: 5)
	maxBlockSequence int                       // highest block sequence number persisted (for tool_result sequencing)

	// JSON delta accumulation (for complete block deltas)
	// Partial JSON deltas are useless - accumulate and send complete JSON once
	jsonAccumulator map[int]string // blockIndex -> accumulated JSON
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
// Accepts minimal interfaces for better ISP compliance: TurnWriter for writes, TurnReader for block reads and catchup
func NewStreamExecutor(
	turnID string,
	model string,
	turnWriter llmRepo.TurnWriter,
	turnReader llmRepo.TurnReader,
	turnNavigator llmRepo.TurnNavigator,
	provider domainllm.LLMProvider,
	toolRegistry *tools.ToolRegistry,
	messageBuilder domainllm.MessageBuilder,
	logger *slog.Logger,
	maxToolRounds int,
	debugMode bool,
) *StreamExecutor {
	se := &StreamExecutor{
		turnID:         turnID,
		model:          model,
		turnRepo:       turnWriter,
		provider:       provider,
		logger:         logger,
		toolRegistry:   toolRegistry,
		turnNavigator:  turnNavigator,
		turnReader:     turnReader,
		messageBuilder: messageBuilder,
		toolIteration:  0,
		maxToolRounds:  maxToolRounds,
	}

	// Create catchup function for database-backed event replay (needs TurnReader)
	serializer := llmModels.NewBlockSerializer()
	catchupFunc := buildCatchupFunc(turnReader, serializer, logger)

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
	// NOTE: Turn stays "streaming" through all continuation rounds.
	// Only marked "complete" when handleCompletion receives stop_reason != "tool_use"
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

	// Delegate to stream processor (reusable for continuation)
	return se.processProviderStream(ctx, streamChan, send)
}

// processProviderStream processes streaming events from the provider.
// This function can be called recursively for tool continuation.
func (se *StreamExecutor) processProviderStream(
	ctx context.Context,
	streamChan <-chan domainllm.StreamEvent,
	send func(mstream.Event),
) error {
	// CRITICAL: Track where this stream starts for sequence remapping
	// Provider always emits block indices starting at 0, but continuation streams
	// need to continue from where we left off (after tool_result blocks)
	// Initial stream: maxBlockSequence = -1, streamStartSequence = 0
	// Continuation: maxBlockSequence = 2, streamStartSequence = 3
	streamStartSequence := se.maxBlockSequence + 1

	// Track current block index for delta events (-1 means no block started yet)
	currentBlockIndex := -1

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

			// Process delta (for real-time UI updates)
			if streamEvent.Delta != nil {
				if err := se.processDelta(ctx, send, streamEvent.Delta, &currentBlockIndex, streamStartSequence); err != nil {
					se.handleError(ctx, send, err)
					return err
				}
			}

			// Process complete block (for database persistence)
			if streamEvent.Block != nil {
				if err := se.processCompleteBlock(ctx, send, streamEvent.Block, streamStartSequence); err != nil {
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

// processDelta handles a single TurnBlockDelta for real-time UI updates.
// - Text/signature deltas are sent immediately (useful for progressive display)
// - JSON deltas are accumulated (partial JSON is unparseable/useless, send complete JSON later)
// streamStartSequence is used to remap provider block indices to turn-level sequences
func (se *StreamExecutor) processDelta(ctx context.Context, send func(mstream.Event), delta *llmModels.TurnBlockDelta, currentBlockIndex *int, streamStartSequence int) error {
	// Detect new block start
	if delta.BlockIndex != *currentBlockIndex {
		// CRITICAL: Remap provider block index to turn-level sequence for SSE event
		// Provider always sends indices 0, 1, 2... but continuation streams need 3, 4, 5...
		turnLevelSequence := streamStartSequence + delta.BlockIndex

		// Send block_start for new block
		se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
			BlockIndex: turnLevelSequence,
			BlockType:  delta.BlockType,
		})

		*currentBlockIndex = delta.BlockIndex
	}

	// Accumulate JSON deltas instead of sending (partial JSON is useless)
	// NOTE: Use provider's block index as map key (not remapped sequence)
	if delta.JSONDelta != nil && *delta.JSONDelta != "" {
		if se.jsonAccumulator == nil {
			se.jsonAccumulator = make(map[int]string)
		}
		se.jsonAccumulator[delta.BlockIndex] += *delta.JSONDelta
		// Don't send - partial JSON is unparseable
		return nil
	}

	// Send text/signature deltas immediately (useful incrementally)
	// CRITICAL: Remap provider block index to turn-level sequence for SSE event
	if delta.DeltaType != "" && (delta.TextDelta != nil || delta.SignatureDelta != nil) {
		turnLevelSequence := streamStartSequence + delta.BlockIndex
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex:     turnLevelSequence,
			DeltaType:      delta.DeltaType,
			TextDelta:      delta.TextDelta,
			SignatureDelta: delta.SignatureDelta,
			JSONDelta:      nil, // Never send partial JSON
		})
	}

	return nil
}

// processCompleteBlock handles a complete, normalized block from the library.
// The library has already normalized provider-specific types (web_search_tool_result → tool_result).
// streamStartSequence is used to remap provider block indices to turn-level sequences
func (se *StreamExecutor) processCompleteBlock(ctx context.Context, send func(mstream.Event), block *llmModels.TurnBlock, streamStartSequence int) error {
	// Set turn ID
	block.TurnID = se.turnID

	// CRITICAL: Save provider's original block index before remapping
	// We need this to access jsonAccumulator (which uses provider indices as keys)
	providerBlockIndex := block.Sequence

	// CRITICAL FIX: Remap provider block index to turn-level sequence
	// Provider always emits blocks starting at index 0 for each stream, but continuation
	// streams need to continue from where we left off (after tool_result blocks)
	// Initial stream: streamStartSequence = 0, provider block 0 → sequence 0
	// Continuation: streamStartSequence = 3, provider block 0 → sequence 3
	block.Sequence = streamStartSequence + providerBlockIndex

	// Collect BACKEND-SIDE tool_use blocks for execution (if tool registry is available)
	// Provider-side tools (e.g., Anthropic's built-in web_search) are already executed by the provider
	// Backend-side tools (e.g., Tavily web search, doc_view, doc_tree) need backend execution
	// TODO: Optimization - start executing tools in background goroutine immediately upon collection
	// instead of waiting for stream completion. This would overlap tool execution with provider
	// streaming, reducing total latency. Currently: collect → stream finishes → execute → stream results.
	// Optimized: collect + execute in background → stream finishes → wait for execution → stream results.
	if se.toolRegistry != nil && block.IsBackendSideTool() {
		se.collectToolUse(block)
	}

	// Persist block to database atomically using PersistAndClear
	// NOTE: We intentionally do NOT check ctx.Done() before persisting.
	// Even if context is cancelled (e.g., client disconnect, server shutdown),
	// we want to persist LLM responses to avoid losing data. This ensures
	// graceful shutdown and allows users to retrieve responses later via catchup.
	if err := se.stream.PersistAndClear(func(events []mstream.Event) error {
		// Persist the block to database
		if err := se.turnRepo.CreateTurnBlock(ctx, block); err != nil {
			return fmt.Errorf("create turn block: %w", err)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("failed to persist block %d: %w", block.Sequence, err)
	}

	// Track max sequence for tool_result block sequencing
	if block.Sequence > se.maxBlockSequence {
		se.maxBlockSequence = block.Sequence
	}

	// Send accumulated JSON as complete delta (if any)
	// This provides complete, parseable JSON instead of useless partial fragments
	// NOTE: Use provider's original block index to access jsonAccumulator
	if accumulatedJSON, exists := se.jsonAccumulator[providerBlockIndex]; exists {
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex: block.Sequence, // Use remapped sequence for SSE
			DeltaType:  llmModels.DeltaTypeJSON,
			JSONDelta:  &accumulatedJSON,
		})
		delete(se.jsonAccumulator, providerBlockIndex) // Cleanup using provider index
	}

	// Send block_stop event to SSE clients
	se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
		BlockIndex: block.Sequence, // Use remapped sequence for SSE
	})

	se.logger.Debug("persisted complete block",
		"block_index", block.Sequence,
		"block_type", block.BlockType,
		"turn_id", se.turnID,
	)

	return nil
}

// handleCompletion handles successful stream completion
func (se *StreamExecutor) handleCompletion(ctx context.Context, send func(mstream.Event), metadata *domainllm.StreamMetadata) error {
	// No need to finalize accumulator - complete blocks are received directly from library
	// and persisted in processCompleteBlock()

	// Use request model as fallback if provider doesn't send it in metadata
	// This prevents validation errors when OpenRouter or other providers omit model in streaming responses
	if metadata.Model == "" {
		metadata.Model = se.model
	}

	// Update turn with metadata
	if err := se.updateTurnMetadata(ctx, metadata); err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to update turn metadata: %w", err))
		return err
	}

	// Check if we have collected tools to execute
	if len(se.collectedTools) > 0 && se.toolRegistry != nil {
		// Check iteration limit to prevent infinite loops
		if se.toolIteration >= se.maxToolRounds {
			se.logger.Warn("max tool rounds reached, completing without tool execution",
				"tool_iteration", se.toolIteration,
				"max_rounds", se.maxToolRounds,
				"collected_tools", len(se.collectedTools),
			)
		} else {
			// Execute tools and continue streaming
			se.logger.Info("executing collected tools",
				"tool_count", len(se.collectedTools),
				"iteration", se.toolIteration,
			)
			return se.executeToolsAndContinue(ctx, send)
		}
	}

	// No tools to execute (or stop_reason != "tool_use"), complete the turn
	return se.completeTurn(ctx, send, metadata.StopReason, metadata)
}

// handleError handles streaming errors
func (se *StreamExecutor) handleError(ctx context.Context, send func(mstream.Event), err error) {
	// No need to finalize accumulator - complete blocks are already persisted
	// Partial blocks are not persisted (streaming stopped mid-block)

	// Update turn status in database
	if updateErr := se.turnRepo.UpdateTurnError(ctx, se.turnID, err.Error()); updateErr != nil {
		se.logger.Error("failed to update turn error", "error", updateErr)
	}

	// Send turn_error event
	errorMsg := err.Error()
	if errorMsg == "" {
		errorMsg = "Unknown error occurred"
	}

	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:         se.turnID,
		Error:          errorMsg,
		LastBlockIndex: nil, // Could be determined from DB if needed
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

// collectToolUse extracts tool use information from a tool_use block and adds it to the collection.
func (se *StreamExecutor) collectToolUse(block *llmModels.TurnBlock) {
	// Extract tool use info from block.Content
	// Expected format: {"tool_use_id": "...", "tool_name": "...", "input": {...}}
	if block.Content == nil {
		se.logger.Warn("tool_use block has no content",
			"sequence", block.Sequence,
			"block_type", block.BlockType)
		return
	}

	// Helper to get map keys for debugging
	getKeys := func(m map[string]interface{}) []string {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		return keys
	}

	// Extract tool_use_id (string)
	toolUseID, ok := block.Content["tool_use_id"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_use_id"]; exists {
			toolUseID = fmt.Sprintf("%v", val)
			se.logger.Debug("tool_use_id extracted via fallback",
				"sequence", block.Sequence,
				"type", fmt.Sprintf("%T", val))
		} else {
			se.logger.Warn("tool_use block missing tool_use_id",
				"sequence", block.Sequence,
				"available_keys", getKeys(block.Content))
			return
		}
	}

	// Extract tool_name (string)
	toolName, ok := block.Content["tool_name"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_name"]; exists {
			toolName = fmt.Sprintf("%v", val)
			se.logger.Debug("tool_name extracted via fallback",
				"sequence", block.Sequence,
				"type", fmt.Sprintf("%T", val))
		} else {
			se.logger.Warn("tool_use block missing tool_name",
				"sequence", block.Sequence,
				"available_keys", getKeys(block.Content))
			return
		}
	}

	// Extract input (map[string]interface{})
	var toolInput map[string]interface{}
	inputRaw, exists := block.Content["input"]
	if !exists {
		se.logger.Warn("tool_use block missing input field",
			"sequence", block.Sequence,
			"available_keys", getKeys(block.Content))
		return
	}

	// Try direct type assertion first (fast path)
	toolInput, ok = inputRaw.(map[string]interface{})
	if !ok {
		// Fallback: marshal to JSON and unmarshal to target type
		// This handles cases where the type is correct but wrapped in interface{}
		inputJSON, err := json.Marshal(inputRaw)
		if err != nil {
			se.logger.Warn("tool_use block input cannot be marshaled",
				"sequence", block.Sequence,
				"input_type", fmt.Sprintf("%T", inputRaw),
				"error", err)
			return
		}

		if err := json.Unmarshal(inputJSON, &toolInput); err != nil {
			se.logger.Warn("tool_use block input cannot be unmarshaled",
				"sequence", block.Sequence,
				"input_json", string(inputJSON),
				"error", err)
			return
		}

		se.logger.Debug("tool input extracted via JSON fallback",
			"sequence", block.Sequence,
			"original_type", fmt.Sprintf("%T", inputRaw))
	}

	// Add to collected tools
	toolCall := tools.ToolCall{
		ID:    toolUseID,
		Name:  toolName,
		Input: toolInput,
	}

	se.collectedTools = append(se.collectedTools, toolCall)

	se.logger.Debug("collected tool use",
		"tool_use_id", toolUseID,
		"tool_name", toolName,
		"tool_count", len(se.collectedTools),
		"sequence", block.Sequence,
	)
}

// executeToolsAndContinue executes the collected tools in parallel, persists the results,
// and continues streaming with the tool results.
func (se *StreamExecutor) executeToolsAndContinue(ctx context.Context, send func(mstream.Event)) error {
	// Execute all collected tools in parallel
	toolResults := se.toolRegistry.ExecuteParallel(ctx, se.collectedTools)

	se.logger.Info("tool execution completed",
		"tool_count", len(toolResults),
		"iteration", se.toolIteration,
	)

	// Persist tool_result blocks to database
	// Each tool result becomes a separate tool_result block
	// Start sequencing after the last block persisted during streaming
	nextSequence := se.maxBlockSequence + 1

	for i, toolResult := range toolResults {
		resultBlock := &llmModels.TurnBlock{
			TurnID:    se.turnID,
			BlockType: llmModels.BlockTypeToolResult,
			Sequence:  nextSequence + i,
			Content: map[string]interface{}{
				"tool_use_id": toolResult.ID,
				"tool_name":   toolResult.Name,
				"is_error":    toolResult.IsError,
			},
		}

		// Add result or error to content
		if toolResult.IsError {
			resultBlock.Content["error"] = toolResult.Error.Error()
		} else {
			resultBlock.Content["result"] = toolResult.Result
		}

		// Persist the tool_result block
		if err := se.turnRepo.CreateTurnBlock(ctx, resultBlock); err != nil {
			se.logger.Error("failed to persist tool result block",
				"error", err,
				"tool_use_id", toolResult.ID,
			)
			// Update turn status to error before returning
			if updateErr := se.turnRepo.UpdateTurnError(ctx, se.turnID, err.Error()); updateErr != nil {
				se.logger.Error("failed to update turn error status", "error", updateErr)
			}
			return fmt.Errorf("failed to persist tool result: %w", err)
		}

		// Track max sequence for potential future tool rounds
		if resultBlock.Sequence > se.maxBlockSequence {
			se.maxBlockSequence = resultBlock.Sequence
		}

		// Stream the tool_result block to frontend via SSE
		// Send block_start
		blockType := resultBlock.BlockType
		se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
			BlockIndex: resultBlock.Sequence,
			BlockType:  &blockType,
		})

		// Send block_delta with full JSON content
		contentJSON, err := json.Marshal(resultBlock.Content)
		if err != nil {
			se.logger.Error("failed to marshal tool result content for delta",
				"error", err,
				"tool_use_id", toolResult.ID,
			)
		} else {
			contentStr := string(contentJSON)
			se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
				BlockIndex:     resultBlock.Sequence,
				DeltaType:      llmModels.DeltaTypeJSON,
				TextDelta:      nil,
				SignatureDelta: nil,
				JSONDelta:      &contentStr,
			})
		}

		// Send block_stop
		se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
			BlockIndex: resultBlock.Sequence,
		})

		se.logger.Debug("persisted and streamed tool result",
			"tool_use_id", toolResult.ID,
			"is_error", toolResult.IsError,
			"sequence", resultBlock.Sequence,
		)
	}

	// 4. Check iteration limit
	se.toolIteration++
	if se.toolIteration >= se.maxToolRounds {
		se.logger.Warn("max tool rounds reached, completing turn",
			"iterations", se.toolIteration,
			"max_rounds", se.maxToolRounds,
		)
		return se.completeTurn(ctx, send, "max_tool_rounds", nil)
	}

	// 5. Load conversation history with tool results (using TurnNavigator + TurnReader)
	path, err := se.turnNavigator.GetTurnPath(ctx, se.turnID)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to load turn path for continuation: %w", err))
		return fmt.Errorf("failed to load turn path for continuation: %w", err)
	}

	// Load blocks for all turns in the path
	for i := range path {
		blocks, err := se.turnReader.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			se.handleError(ctx, send, fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err))
			return fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err)
		}
		path[i].Blocks = blocks
	}

	// 6. Build messages using MessageBuilder (pure conversion)
	messages, err := se.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to build continuation messages: %w", err))
		return fmt.Errorf("failed to build continuation messages: %w", err)
	}

	se.logger.Debug("built continuation messages",
		"message_count", len(messages),
		"iteration", se.toolIteration,
		"next_block_sequence", se.maxBlockSequence+1,
	)

	// 7. Create continuation request (reuse original params)
	contReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    se.req.Model,
		Params:   se.req.Params, // Reuse original params (temperature, max_tokens, system prompt, etc.)
	}

	// 8. Call provider for continuation stream
	// NOTE: Use ctx from workFunc (NOT context.Background())
	// - The background goroutine already uses context.Background() (see service.go:304)
	// - This ctx comes from mstream, which manages stream lifecycle
	// - Browser disconnection doesn't cancel this ctx (goroutine-level protection)
	// - Using mstream's ctx prevents goroutine leaks and respects cancellation
	contStreamChan, err := se.provider.StreamResponse(ctx, contReq)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("continuation stream failed: %w", err))
		return fmt.Errorf("continuation stream failed: %w", err)
	}

	se.logger.Info("continuation stream started",
		"iteration", se.toolIteration,
		"next_expected_block", se.maxBlockSequence+1,
	)

	// 9. Reset tool collection for next iteration
	se.collectedTools = nil

	// 10. Process continuation stream (recursive call)
	// maxBlockSequence will be updated by processProviderStream -> processCompleteBlock
	return se.processProviderStream(ctx, contStreamChan, send)
}

// completeTurn marks the turn as complete and sends turn_complete event.
// This is called ONLY when stop_reason != "tool_use" (or max iterations hit).
// The turn remains "streaming" during all continuation rounds.
// metadata can be nil (e.g., when max_tool_rounds is hit before next stream)
func (se *StreamExecutor) completeTurn(
	ctx context.Context,
	send func(mstream.Event),
	stopReason string,
	metadata *domainllm.StreamMetadata,
) error {
	se.logger.Info("completing turn",
		"turn_id", se.turnID,
		"stop_reason", stopReason,
		"total_tool_iterations", se.toolIteration,
	)

	// Update turn status in database
	// NOTE: This marks the FINAL completion after all continuation rounds
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "complete", nil); err != nil {
		se.logger.Error("failed to update turn status", "error", err)
		// Continue despite error - SSE event is more important
	}

	// Build completion event
	completeEvent := llmModels.TurnCompleteEvent{
		TurnID:     se.turnID,
		StopReason: stopReason,
	}

	// Add metadata if available (may be nil for max_tool_rounds)
	if metadata != nil {
		completeEvent.InputTokens = metadata.InputTokens
		completeEvent.OutputTokens = metadata.OutputTokens
		completeEvent.ResponseMetadata = metadata.ResponseMetadata
	}

	// Send turn_complete SSE event
	se.sendEvent(send, llmModels.SSEEventTurnComplete, completeEvent)

	return nil
}
