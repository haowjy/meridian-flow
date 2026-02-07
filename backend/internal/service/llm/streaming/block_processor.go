package streaming

import (
	"context"
	"fmt"
	"sort"
	"strings"

	mstream "github.com/haowjy/meridian-stream-go"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"

	llmModels "meridian/internal/domain/models/llm"
	domainllm "meridian/internal/domain/services/llm"
)

// canPersistPartialBlock returns true for block types that are useful when partial.
// Text and thinking are human-readable; tool_use JSON is unparseable when incomplete.
func canPersistPartialBlock(blockType string) bool {
	return blockType == llmModels.BlockTypeText || blockType == llmModels.BlockTypeThinking
}

// processAGUIEvent handles AG-UI protocol events from the library.
// These events are forwarded directly to SSE using the AG-UI emitter.
// The function also maintains internal state (text accumulator) for partial block persistence.
//
// AG-UI events include:
//   - TEXT_MESSAGE_START/CONTENT/END - text streaming
//   - THINKING_START/CONTENT/END - thinking/reasoning content
//   - TOOL_CALL_START/ARGS/END - tool call streaming
//   - RUN_STARTED/FINISHED/ERROR - lifecycle events (emitted by us, not library)
//
// streamStartSequence is used for block index tracking (though AG-UI events are self-contained)
func (se *StreamExecutor) processAGUIEvent(_ context.Context, send func(mstream.Event), aguiEvent any, currentBlockIndex *int, streamStartSequence int) error {
	// After soft cancel (DrainMetadata state), we keep draining the provider stream for metadata,
	// but we stop emitting SSE events
	if !se.state.AllowsSSE() {
		return nil
	}

	// Type assert to events.Event interface
	evt, ok := aguiEvent.(events.Event)
	if !ok {
		se.logger.Warn("received non-Event AG-UI event",
			"turn_id", se.turnID,
			"event_type", fmt.Sprintf("%T", aguiEvent),
		)
		return nil
	}

	// Forward the AG-UI event via the emitter (serializes to SSE format)
	if err := se.aguiEmitter.EmitAGUIEvent(evt); err != nil {
		se.logger.Error("failed to emit AG-UI event",
			"turn_id", se.turnID,
			"event_type", evt.Type(),
			"error", err,
		)
		// Don't fail the stream - log and continue
	}

	// Accumulate text for partial block persistence on interruption
	// This mirrors what processDelta does, but using AG-UI event types
	switch e := evt.(type) {
	case *events.TextMessageContentEvent:
		if e.Delta != "" {
			if se.textAccumulator == nil {
				se.textAccumulator = make(map[int]string)
			}
			// Use currentBlockIndex for accumulation (we track blocks ourselves)
			blockIdx := *currentBlockIndex
			if blockIdx < 0 {
				blockIdx = 0
			}
			se.textAccumulator[blockIdx] += e.Delta
		}

	case *events.TextMessageStartEvent:
		// Track last assistant message ID for best-effort correlation.
		// Some tool events may omit parentMessageId; this fallback keeps TOOL_CALL_RESULT usable.
		if e.Role == nil || *e.Role == "assistant" {
			se.lastAssistantMessageID = e.MessageID
		}

		// Track new block start
		*currentBlockIndex++
		blockIdx := *currentBlockIndex
		if se.blockTypes == nil {
			se.blockTypes = make(map[int]string)
		}
		se.blockTypes[blockIdx] = llmModels.BlockTypeText

	case *events.ThinkingTextMessageContentEvent:
		if e.Delta != "" {
			if se.textAccumulator == nil {
				se.textAccumulator = make(map[int]string)
			}
			blockIdx := *currentBlockIndex
			if blockIdx < 0 {
				blockIdx = 0
			}
			se.textAccumulator[blockIdx] += e.Delta
		}

	case *events.ThinkingStartEvent:
		// Track new thinking block start
		*currentBlockIndex++
		blockIdx := *currentBlockIndex
		if se.blockTypes == nil {
			se.blockTypes = make(map[int]string)
		}
		se.blockTypes[blockIdx] = llmModels.BlockTypeThinking

	case *events.ToolCallStartEvent:
		// Record parent message correlation for backend-emitted TOOL_CALL_RESULT.
		// Providers occasionally include leading/trailing whitespace in toolCallId; store both.
		parentMessageID := ""
		if e.ParentMessageID != nil {
			parentMessageID = *e.ParentMessageID
		} else if se.lastAssistantMessageID != "" {
			parentMessageID = se.lastAssistantMessageID
		}
		if parentMessageID != "" {
			se.toolCallParentMessageIDs[e.ToolCallID] = parentMessageID
			se.toolCallParentMessageIDs[strings.TrimSpace(e.ToolCallID)] = parentMessageID
		}

		// Track new tool_use block start
		*currentBlockIndex++
		blockIdx := *currentBlockIndex
		if se.blockTypes == nil {
			se.blockTypes = make(map[int]string)
		}
		se.blockTypes[blockIdx] = llmModels.BlockTypeToolUse
		// NOTE: Legacy tool metadata tracking removed - AG-UI handles tool streaming display

	case *events.ToolCallArgsEvent:
		// Accumulate JSON for tool input
		if e.Delta != "" {
			if se.jsonAccumulator == nil {
				se.jsonAccumulator = make(map[int]string)
			}
			blockIdx := *currentBlockIndex
			if blockIdx < 0 {
				blockIdx = 0
			}
			se.jsonAccumulator[blockIdx] += e.Delta
		}
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

	// If not in Streaming state, skip all persistence/tool collection and SSE.
	// Partial text (accumulated before cancel) is persisted by handleSoftCancel().
	if !se.state.AllowsPersistence() {
		// Best-effort cleanup for this block index to avoid unbounded memory growth.
		if se.jsonAccumulator != nil {
			delete(se.jsonAccumulator, providerBlockIndex)
		}
		if se.textAccumulator != nil {
			delete(se.textAccumulator, providerBlockIndex)
		}
		if se.blockTypes != nil {
			delete(se.blockTypes, providerBlockIndex)
		}
		return nil
	}

	// Collect LOCAL tool_use blocks for execution (if tool registry is available)
	// Provider-side tools (e.g., Anthropic's built-in web_search) are already executed by the provider
	// Local tools (e.g., Tavily web search, str_replace_based_edit_tool) need backend execution
	// TODO: Optimization - start executing tools in background goroutine immediately upon collection
	// instead of waiting for stream completion. This would overlap tool execution with provider
	// streaming, reducing total latency. Currently: collect → stream finishes → execute → stream results.
	// Optimized: collect + execute in background → stream finishes → wait for execution → stream results.
	if se.toolRegistry != nil && block.IsLocalTool() {
		se.collectToolUse(block)
	}

	// Persist block to database atomically using PersistAndClear
	// NOTE: We intentionally do NOT check ctx.Done() before persisting.
	// Even if context is cancelled (e.g., client disconnect, server shutdown),
	// we want to persist LLM responses to avoid losing data. This ensures
	// graceful shutdown and allows users to retrieve responses later via catchup.
	persisted := false
	if err := se.stream.PersistAndClear(func(events []mstream.Event) error {
		// CRITICAL: Use PersistenceGuard as primary check.
		// The guard is disarmed IMMEDIATELY when cancel is requested (atomic store),
		// so this check is race-free. The state check alone has a race window because
		// state only changes when the select loop processes the command.
		if !se.persistenceGuard.IsArmed() {
			se.logger.Debug("skipping block persistence (guard disarmed)",
				"block_type", block.BlockType,
				"sequence", block.Sequence,
			)
			return nil
		}

		// Belt-and-suspenders: Also check state (should be redundant now)
		if se.getState() != StateStreaming {
			se.logger.Debug("skipping block persistence in callback (not streaming)",
				"block_type", block.BlockType,
				"sequence", block.Sequence,
				"state", se.getState().String(),
			)
			return nil
		}

		// Persist the block to database
		if err := se.turnRepo.CreateTurnBlock(ctx, block); err != nil {
			return fmt.Errorf("create turn block: %w", err)
		}
		persisted = true
		return nil
	}); err != nil {
		return fmt.Errorf("failed to persist block %d: %w", block.Sequence, err)
	}

	// If we didn't persist (due to interruption), clean up and return early without SSE events.
	if !persisted {
		if se.jsonAccumulator != nil {
			delete(se.jsonAccumulator, providerBlockIndex)
		}
		if se.textAccumulator != nil {
			delete(se.textAccumulator, providerBlockIndex)
		}
		if se.blockTypes != nil {
			delete(se.blockTypes, providerBlockIndex)
		}
		return nil
	}

	// Track max sequence for tool_result block sequencing
	if block.Sequence > se.maxBlockSequence {
		se.maxBlockSequence = block.Sequence
	}

	// Track tool_result IDs from provider (e.g., decode error results)
	// This prevents backend from executing tools that already have results
	if block.BlockType == llmModels.BlockTypeToolResult {
		if toolUseID, ok := block.Content["tool_use_id"].(string); ok {
			se.toolResultIDs[toolUseID] = true
		}
	}

	// Clean up accumulators for this completed block
	// NOTE: Legacy SSE block events have been removed - AG-UI handles streaming display
	if se.jsonAccumulator != nil {
		delete(se.jsonAccumulator, providerBlockIndex)
	}
	if se.textAccumulator != nil {
		delete(se.textAccumulator, providerBlockIndex)
	}
	if se.blockTypes != nil {
		delete(se.blockTypes, providerBlockIndex)
	}

	se.logger.Debug("persisted complete block",
		"block_index", block.Sequence,
		"block_type", block.BlockType,
		"turn_id", se.turnID,
	)

	return nil
}

// processGenerationIDDiscovered handles early generation ID discovery event.
// This is emitted on the first chunk from the provider, allowing us to persist
// a partial GenerationRecord early in the stream. This enables background
// enrichment even if the stream is cancelled before completion.
//
// This is a non-terminal event - streaming continues after this event.
// Failures are logged but don't stop the stream (best-effort persistence).
func (se *StreamExecutor) processGenerationIDDiscovered(
	ctx context.Context,
	event *domainllm.GenerationIDEvent,
) error {
	// Capture generation ID for later use (thread-safe via mutex)
	// This allows cancel strategies to access the ID when needed
	se.setGenerationID(event.GenerationID)

	// Log discovery for observability
	se.logger.Debug("generation ID discovered",
		"turn_id", se.turnID,
		"generation_id", event.GenerationID,
		"model", event.Model,
		"provider", event.Provider,
		"request_index", se.requestIndex,
		"tool_iteration", se.toolIteration,
	)

	// Determine phase based on tool iteration
	// Initial request: toolIteration = 0, phase = "initial"
	// Tool continuations: toolIteration > 0, phase = "tool_continue"
	phase := "initial"
	if se.toolIteration > 0 {
		phase = "tool_continue"
	}

	// Build partial GenerationRecord (only ID + metadata fields)
	// This will be enriched later via background job when stream completes/cancels
	partialRecord := &llmModels.GenerationRecord{
		ID:           event.GenerationID,
		RequestIndex: se.requestIndex,
		Phase:        phase,
		Model:        event.Model,
		Finalized:    false, // Will be enriched via background job
	}

	// Persist partial record to database (upsert-by-id)
	// If this fails, log but don't stop stream - enrichment can still happen
	// via final metadata event as fallback
	if err := se.turnRepo.AppendGenerationRecord(ctx, se.turnID, partialRecord); err != nil {
		return fmt.Errorf("append partial generation record: %w", err)
	}

	return nil
}

// persistPartialBlocks saves any accumulated text/thinking blocks as partial blocks.
// Called during error/interruption handling to preserve partial LLM responses.
func (se *StreamExecutor) persistPartialBlocks(ctx context.Context) {
	if len(se.textAccumulator) == 0 {
		return
	}

	se.logger.Debug("persisting partial blocks",
		"turn_id", se.turnID,
		"block_count", len(se.textAccumulator),
	)

	for providerBlockIndex, textContent := range se.textAccumulator {
		if textContent == "" {
			continue
		}

		// Only persist text/thinking blocks - tool_use JSON is unparseable when partial
		blockType := llmModels.BlockTypeText // default to text
		if bt, exists := se.blockTypes[providerBlockIndex]; exists {
			blockType = bt
		}

		// Skip blocks that aren't useful when partial (e.g., tool_use with incomplete JSON)
		if !canPersistPartialBlock(blockType) {
			se.logger.Debug("skipping partial block (not text/thinking)",
				"block_type", blockType,
				"provider_index", providerBlockIndex,
			)
			continue
		}

		// Calculate turn-level sequence
		// maxBlockSequence tracks the highest completed block sequence
		// Partial blocks continue from there
		turnSequence := se.maxBlockSequence + 1 + providerBlockIndex

		// Create partial block
		partialBlock := &llmModels.TurnBlock{
			TurnID:      se.turnID,
			BlockType:   blockType,
			Sequence:    turnSequence,
			TextContent: &textContent,
			Status:      "partial",
		}

		// Persist the partial block
		if err := se.turnRepo.UpsertPartialBlock(ctx, partialBlock); err != nil {
			se.logger.Error("failed to persist partial text block",
				"error", err,
				"sequence", turnSequence,
				"text_length", len(textContent),
			)
		} else {
			se.logger.Debug("persisted partial text block",
				"sequence", turnSequence,
				"text_length", len(textContent),
			)
		}
	}

	// Clear accumulators after persistence attempt
	se.textAccumulator = nil
	se.blockTypes = nil
}

// getAccumulatedText returns all accumulated text from the text accumulator.
// Used for token counting on interruption.
func (se *StreamExecutor) getAccumulatedText() string {
	if len(se.textAccumulator) == 0 {
		return ""
	}

	// Deterministic ordering: map iteration is randomized.
	// Token counting should use content in provider block order.
	blockIndexes := make([]int, 0, len(se.textAccumulator))
	for idx := range se.textAccumulator {
		blockIndexes = append(blockIndexes, idx)
	}
	sort.Ints(blockIndexes)

	// Use strings.Builder for O(n) concatenation instead of O(n²) with +=
	var builder strings.Builder
	for _, idx := range blockIndexes {
		builder.WriteString(se.textAccumulator[idx])
	}
	return builder.String()
}
