package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/pkg/sliceutil"
	"meridian/internal/service/llm/streaming/agui"
	"meridian/internal/service/llm/tools"
)

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

	// Extract tool_use_id (string)
	toolUseID, ok := block.Content["tool_use_id"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_use_id"]; exists {
			toolUseID = fmt.Sprintf("%v", val)
		} else {
			se.logger.Warn("tool_use block missing tool_use_id",
				"sequence", block.Sequence,
				"available_keys", sliceutil.Keys(block.Content))
			return
		}
	}

	// Extract tool_name (string)
	toolName, ok := block.Content["tool_name"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_name"]; exists {
			toolName = fmt.Sprintf("%v", val)
		} else {
			se.logger.Warn("tool_use block missing tool_name",
				"sequence", block.Sequence,
				"available_keys", sliceutil.Keys(block.Content))
			return
		}
	}

	// Extract input (map[string]interface{})
	var toolInput map[string]interface{}
	inputRaw, exists := block.Content["input"]
	if !exists {
		se.logger.Warn("tool_use block missing input field",
			"sequence", block.Sequence,
			"available_keys", sliceutil.Keys(block.Content))
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
	}

	// Add to collected tools
	toolCall := tools.ToolCall{
		ID:    toolUseID,
		Name:  toolName,
		Input: toolInput,
	}

	se.collectedTools = append(se.collectedTools, toolCall)
}

// executeToolsAndContinue executes the collected tools in parallel, persists the results,
// and continues streaming with the tool results.
func (se *StreamExecutor) executeToolsAndContinue(ctx context.Context, send func(mstream.Event)) error {
	// Filter out tools that already have results (from provider decode errors)
	// This prevents duplicate tool_result blocks for the same tool_use_id
	var toolsToExecute []tools.ToolCall
	for _, tc := range se.collectedTools {
		if !se.toolResultIDs[tc.ID] {
			toolsToExecute = append(toolsToExecute, tc)
		} else {
			se.logger.Debug("skipping tool execution - result already exists",
				"tool_use_id", tc.ID,
				"tool_name", tc.Name,
			)
		}
	}

	// NOTE: Legacy tool_executing events removed - AG-UI handles tool execution state

	// Inject thread context so tools can attribute edits to the originating conversation.
	// This enables provenance tracking in collab proposals (Phase 4.5).
	ctx = tools.InjectThreadContext(ctx, se.threadID, se.turnID, se.userID)

	// Execute filtered tools in parallel
	toolResults := se.toolRegistry.ExecuteParallel(ctx, toolsToExecute)

	se.logger.Info("tool execution completed",
		"tool_count", len(toolResults),
		"skipped_count", len(se.collectedTools)-len(toolsToExecute),
		"iteration", se.toolIteration,
	)

	// Persist tool_result blocks to database
	// Each tool result becomes a separate tool_result block
	// Start sequencing after the last block persisted during streaming
	nextSequence := se.maxBlockSequence + 1

	for i, toolResult := range toolResults {
		block := &llmModels.TurnBlock{
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
			block.Content["error"] = toolResult.Error.Error()
		} else {
			block.Content["result"] = toolResult.Result
		}

		if err := se.persistToolResult(ctx, block); err != nil {
			// Update turn status to error before returning
			if updateErr := se.turnRepo.UpdateTurnError(ctx, se.turnID, err.Error()); updateErr != nil {
				se.logger.Error("failed to update turn error status", "error", updateErr)
			}
			return err
		}

		// Emit TOOL_CALL_RESULT immediately so the frontend can mark tools as finished
		// without waiting for TURN_COMPLETE refresh. Best-effort: failure shouldn't stop streaming.
		if se.aguiEmitter != nil && se.getState().AllowsSSE() {
			messageID := se.toolCallParentMessageIDs[toolResult.ID]
			if messageID == "" {
				messageID = se.toolCallParentMessageIDs[strings.TrimSpace(toolResult.ID)]
			}
			if messageID == "" {
				messageID = se.lastAssistantMessageID
			}

			if messageID != "" {
				eventPayload := map[string]interface{}{
					"tool_use_id": toolResult.ID,
					"tool_name":   toolResult.Name,
					"is_error":    toolResult.IsError,
				}
				if toolResult.IsError {
					eventPayload["error"] = toolResult.Error.Error()
				} else {
					eventPayload["result"] = toolResult.Result
				}

				payloadBytes, err := json.Marshal(eventPayload)
				if err != nil {
					se.logger.Warn("failed to marshal TOOL_CALL_RESULT payload",
						"tool_use_id", toolResult.ID,
						"error", err,
					)
				} else {
					se.aguiEmitter.EmitToolCallResult(messageID, toolResult.ID, string(payloadBytes))
				}
			} else {
				se.logger.Debug("skipping TOOL_CALL_RESULT (no messageId available)",
					"tool_use_id", toolResult.ID,
					"tool_name", toolResult.Name,
				)
			}
		}
	}

	// INTERJECTION POINT A: Check for interjection after tool results are persisted.
	// If user submitted an interjection during tool execution, inject it now by
	// creating a new user turn and switching to a new assistant stream.
	if se.interjectionBuffer != nil && se.streamSwitchFn != nil {
		if interjection, ok := se.interjectionBuffer.DrainAndClear(); ok {
			se.logger.Info("interjection detected at tool boundary, triggering stream switch",
				"turn_id", se.turnID,
				"interjection_length", len(interjection),
			)

			// Call stream switch to create new turns and start new stream
			result, err := se.streamSwitchFn(ctx, se.turnID, interjection, "tool_boundary")
			if err != nil {
				se.logger.Error("stream switch failed at tool boundary",
					"turn_id", se.turnID,
					"error", err,
				)
				// Emit error and return - don't continue with current stream
				se.handleError(ctx, send, fmt.Errorf("interjection stream switch failed: %w", err))
				return fmt.Errorf("interjection stream switch failed: %w", err)
			}

			// Emit STREAM_SWITCH event so frontend can reconnect to new stream
			if se.aguiEmitter != nil {
				se.aguiEmitter.EmitStreamSwitch(
					se.turnID,
					agui.StreamSwitchReasonToolBoundary,
					result.UserTurn,
					result.AssistantTurn,
					result.StreamURL,
				)
			}

			// End current stream cleanly - frontend will connect to new stream
			se.logger.Info("stream switch completed, ending current stream",
				"prev_turn_id", se.turnID,
				"stream_url", result.StreamURL,
			)
			se.transitionTo(StateCompleted)
			if se.onCleanup != nil {
				se.onCleanup()
			}
			return nil
		}
	}

	// 4. Check iteration limit with tiered approach
	se.toolIteration++
	se.requestIndex++ // Increment request index for next LLM request (for generation metadata tracking)

	if err := se.creditAdmissionChecker.CheckAdmission(ctx, se.userID); err != nil {
		se.logger.Warn("credit admission denied before tool continuation provider call",
			"turn_id", se.turnID,
			"user_id", se.userID,
			"request_index", se.requestIndex,
			"phase", "tool_continue",
			"error", err,
		)
		se.handleCreditsExhausted(ctx, send, se.requestIndex, "tool_continue")
		return nil
	}

	// Emit AG-UI STEP_FINISHED for current step, then STEP_STARTED for next step
	// This signals the transition between LLM requests in the tool continuation loop
	if se.aguiEmitter != nil {
		se.aguiEmitter.EmitStepFinished()
		se.idFactory.IncrementStep() // Move to next step for ID generation
		se.aguiEmitter.EmitStepStarted()
	}

	// Warning threshold: 5 rounds before limit (skip if maxToolRounds <= 5)
	warnThreshold := se.maxToolRounds - 5

	// HARD LIMIT: Error at maxToolRounds (no doubling)
	if se.toolIteration >= se.maxToolRounds {
		se.logger.Warn("tool round limit reached, forcing graceful completion",
			"iterations", se.toolIteration,
			"max_rounds", se.maxToolRounds,
		)
		return se.executeToolsAndContinueWithLimit(ctx, send)
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

	// 6a. WARNING: Inject notification if at or past warn threshold (only if maxToolRounds > 5)
	// This gives the LLM a gentle reminder to wrap up, but still allows tool use if critical
	if se.maxToolRounds > 5 && se.toolIteration >= warnThreshold {
		remainingRounds := se.maxToolRounds - se.toolIteration
		notificationText := fmt.Sprintf(
			"You have %d tool rounds remaining (limit: %d). "+
				"Please consider wrapping up or providing your final answer soon.",
			remainingRounds, se.maxToolRounds,
		)

		notificationMsg := domainllm.Message{
			Role: "user",
			Content: []*llmModels.TurnBlock{
				{
					BlockType:   llmModels.BlockTypeText,
					TextContent: &notificationText,
				},
			},
		}

		// Prepend notification so LLM sees it first
		messages = append([]domainllm.Message{notificationMsg}, messages...)

		se.logger.Info("warning threshold reached, injected notification",
			"iterations", se.toolIteration,
			"warn_threshold", warnThreshold,
			"max_rounds", se.maxToolRounds,
			"remaining", remainingRounds,
		)
	}

	// 7. Create continuation request (reuse original params)
	contReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    se.req.Model,
		Params:   se.req.Params, // Reuse original params (temperature, max_tokens, system prompt, etc.)
	}

	// DEBUG: Log continuation request details to diagnose 400 errors
	se.logContinuationRequest(contReq)

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
	se.toolResultIDs = make(map[string]bool)

	// 10. Process continuation stream (recursive call)
	// maxBlockSequence will be updated by processProviderStream -> processCompleteBlock
	return se.processProviderStream(ctx, contStreamChan, send)
}

// persistToolResult persists a tool_result block to the database.
// This is the shared helper used by both executeToolsAndContinue (real results)
// and persistErrorToolResults (error results) to avoid code duplication.
// NOTE: Legacy SSE block events have been removed - AG-UI handles streaming display.
func (se *StreamExecutor) persistToolResult(ctx context.Context, block *llmModels.TurnBlock) error {
	// 1. Persist to database
	if err := se.turnRepo.CreateTurnBlock(ctx, block); err != nil {
		se.logger.Error("failed to persist tool result block",
			"error", err,
			"tool_use_id", block.Content["tool_use_id"],
		)
		return fmt.Errorf("failed to persist tool result: %w", err)
	}

	// 2. Update sequence tracking
	if block.Sequence > se.maxBlockSequence {
		se.maxBlockSequence = block.Sequence
	}

	se.logger.Debug("persisted tool result",
		"tool_use_id", block.Content["tool_use_id"],
		"is_error", block.Content["is_error"],
		"sequence", block.Sequence,
	)

	return nil
}

// persistErrorToolResults creates error tool_result blocks for all collected tools
// without executing them. Used when we hit hard limit before tool execution.
// This ensures every tool_use has a corresponding tool_result (required by Claude API).
func (se *StreamExecutor) persistErrorToolResults(ctx context.Context, send func(mstream.Event), errMsg string) error {
	if len(se.collectedTools) == 0 {
		return nil
	}

	se.logger.Info("persisting error tool results for collected tools",
		"tool_count", len(se.collectedTools),
		"error_message", errMsg,
	)

	nextSequence := se.maxBlockSequence + 1

	for i, tool := range se.collectedTools {
		block := &llmModels.TurnBlock{
			TurnID:    se.turnID,
			BlockType: llmModels.BlockTypeToolResult,
			Sequence:  nextSequence + i,
			Content: map[string]interface{}{
				"tool_use_id": tool.ID,
				"tool_name":   tool.Name,
				"is_error":    true,
				"error":       errMsg,
			},
		}

		if err := se.persistToolResult(ctx, block); err != nil {
			return err
		}
	}

	// Clear collected tools after persisting error results
	se.collectedTools = nil
	se.toolResultIDs = make(map[string]bool)

	return nil
}

// executeToolsAndContinueWithLimit is called when tool round limit is reached.
// It loads conversation history (including tool results just persisted), injects
// a limit note into the last tool_result, and streams one final LLM response.
// This allows graceful completion where the LLM synthesizes findings instead of abrupt cutoff.
func (se *StreamExecutor) executeToolsAndContinueWithLimit(ctx context.Context, send func(mstream.Event)) error {
	// Caller owns requestIndex increment and admission check.
	// This avoids double-increment when executeToolsAndContinue already advanced state.
	se.logger.Info("graceful completion: injecting limit note for final LLM response",
		"iteration", se.toolIteration,
		"max_rounds", se.maxToolRounds,
	)

	// 1. Load conversation history with tool results (using TurnNavigator + TurnReader)
	path, err := se.turnNavigator.GetTurnPath(ctx, se.turnID)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to load turn path for graceful completion: %w", err))
		return fmt.Errorf("failed to load turn path for graceful completion: %w", err)
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

	// 2. Build messages using MessageBuilder (pure conversion)
	messages, err := se.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to build messages for graceful completion: %w", err))
		return fmt.Errorf("failed to build messages for graceful completion: %w", err)
	}

	// 3. INJECT LIMIT NOTE into last tool_result message
	// This tells the LLM it has reached the limit and should respond with gathered info
	// Note: This modifies messages in-memory only (NOT persisted to database)
	injectToolLimitNote(messages, se.toolIteration, se.maxToolRounds)

	// 4. Create continuation request with system prompt override
	// IMPORTANT: Keep tools array even though we don't want the LLM to call them.
	// Reason: Messages contain role:"tool" blocks (for OpenRouter), and OpenRouter
	// rejects role:"tool" messages when no tools are defined in the request (400 error).
	// The system prompt override is sufficient to prevent the LLM from calling tools.
	paramsWithoutTools := *se.req.Params // Shallow copy
	// paramsWithoutTools.Tools remains unchanged (keeps original tools for message validation)

	// Dual-layer defense against unwanted tool calls:
	// Layer 1: System prompt override (strong instruction to NOT call tools)
	// Layer 2: Tool result limit note (provides context - already injected above)
	limitInstruction := "\n\nIMPORTANT: You have reached your tool usage limit. " +
		"Do NOT format any tool calls. " +
		"Provide your answer in natural language based on the information you gathered. " +
		"Let the user know you reached the tool limit and are providing your best answer with available information."

	if paramsWithoutTools.System != nil {
		originalPrompt := *paramsWithoutTools.System
		updatedPrompt := originalPrompt + limitInstruction
		paramsWithoutTools.System = &updatedPrompt
	} else {
		paramsWithoutTools.System = &limitInstruction
	}

	contReq := &domainllm.GenerateRequest{
		Messages: messages, // Contains limit note in last tool_result (Layer 2)
		Model:    se.req.Model,
		Params:   &paramsWithoutTools, // Tools kept + limit instruction (Layer 1)
	}

	// DEBUG: Log continuation request details to diagnose 400 errors
	se.logContinuationRequest(contReq)

	// 5. Call provider for final continuation stream
	contStreamChan, err := se.provider.StreamResponse(ctx, contReq)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("graceful completion stream failed: %w", err))
		return fmt.Errorf("graceful completion stream failed: %w", err)
	}

	se.logger.Info("graceful completion stream started",
		"iteration", se.toolIteration,
		"next_expected_block", se.maxBlockSequence+1,
	)

	// 6. Reset tool collection (no more tool rounds allowed)
	se.collectedTools = nil
	se.toolResultIDs = make(map[string]bool)

	// 7. Process final stream (will complete with end_turn stop_reason)
	return se.processProviderStream(ctx, contStreamChan, send)
}

// injectToolLimitNote appends a limit notification to the last tool_result block.
// This tells the LLM it has reached the maximum tool rounds and should respond
// with the information gathered so far. The note is injected into messages
// before sending to the provider, but is NOT persisted to the database.
func injectToolLimitNote(messages []domainllm.Message, currentRound, maxRounds int) {
	// Find last message with role="user" (tool results are sent as user messages)
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			// Find last tool_result block in this message
			blocks := messages[i].Content
			for j := len(blocks) - 1; j >= 0; j-- {
				if blocks[j].BlockType == llmModels.BlockTypeToolResult {
					// Inject limit note into the result field
					// Content is already map[string]interface{} - no type assertion needed
					content := blocks[j].Content
					if result, exists := content["result"]; exists {
						// Append limit note to existing result
						resultStr := fmt.Sprintf("%v", result)
						limitNote := fmt.Sprintf(
							"\n\n---\nNote: You have reached the maximum tool rounds (%d/%d). Please provide your response based on the information you've gathered so far. No additional tool calls are available.",
							currentRound, maxRounds,
						)
						content["result"] = resultStr + limitNote
					}
					return
				}
			}
		}
	}
}
