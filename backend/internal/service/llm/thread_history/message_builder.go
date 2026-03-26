package threadhistory

import (
	"context"
	"fmt"
	"log/slog"

	"meridian/internal/capabilities"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/formatting"
)

// MessageBuilderService converts thread history (database turns) to LLM messages.
// This is a pure conversion service - data loading happens in the caller.
type MessageBuilderService struct {
	formatterRegistry  *formatting.FormatterRegistry
	capabilityRegistry *capabilities.Registry
	logger             *slog.Logger
}

// NewMessageBuilderService creates a new MessageBuilderService
func NewMessageBuilderService(
	formatterRegistry *formatting.FormatterRegistry,
	capabilityRegistry *capabilities.Registry,
	logger *slog.Logger,
) *MessageBuilderService {
	return &MessageBuilderService{
		formatterRegistry:  formatterRegistry,
		capabilityRegistry: capabilityRegistry,
		logger:             logger,
	}
}

// BuildMessages converts a turn path (with blocks already loaded) to LLM messages
// suitable for provider requests. The path should be ordered from oldest to newest.
// The caller must load turn blocks before calling this method.
//
// Bookmark handling (when bookmark turns are present in the path):
//  1. Compaction turn: all turns before it (inclusive) are skipped; the turn's summary
//     text is injected as a leading user context message.
//  2. Collapse marker: tool_result blocks in turns before the marker get their full
//     content replaced by collapsed_content (if set on the block).
//  3. Multiple bookmarks: most-recent of each type wins; collapse markers earlier than
//     the compaction turn are ignored (superseded by the compaction cutoff).
//
// No bookmarks → output is identical to pre-bookmark behaviour (regression-safe).
func (mb *MessageBuilderService) BuildMessages(
	ctx context.Context,
	path []domainllm.Turn,
) ([]domainllm.Message, error) {
	// --- Bookmark boundary detection ---
	// Find the latest compaction turn (hard cutoff: skip everything at or before it).
	compactionIdx := domainllm.FindLastCompactionTurn(path)

	// Find the latest collapse marker. A collapse marker at or before the compaction
	// cutoff is irrelevant — the compaction already skips those turns.
	collapseMarkerIdx := domainllm.FindLastCollapseMarker(path)
	if compactionIdx >= 0 && collapseMarkerIdx <= compactionIdx {
		collapseMarkerIdx = -1
	}

	messages := make([]domainllm.Message, 0, len(path))

	// --- Inject compaction summary ---
	// The summary is prepended as a user context message so the LLM understands
	// what happened before the bookmark cut-off.
	if compactionIdx >= 0 {
		summary := domainllm.ExtractCompactionSummary(path[compactionIdx])
		if summary != "" {
			summaryText := "[Previous conversation summary]\n" + summary
			summaryBlock := &domainllm.TurnBlock{
				BlockType:   domainllm.BlockTypeText,
				TextContent: &summaryText,
			}
			messages = append(messages, domainllm.Message{
				Role:    domainllm.TurnRoleUser,
				Content: []*domainllm.TurnBlock{summaryBlock},
			})
			mb.logger.Debug("injected compaction summary",
				"compaction_turn_index", compactionIdx,
				"summary_len", len(summary),
			)
		}
	}

	// --- Process turns ---
	for i, turn := range path {
		// Skip all turns up to and including the compaction bookmark.
		if compactionIdx >= 0 && i <= compactionIdx {
			continue
		}

		// Skip bookmark turns — they are not sent to the LLM directly.
		if turn.IsBookmarkTurn() {
			continue
		}

		// Determine role.
		var role string
		switch turn.Role {
		case domainllm.TurnRoleUser:
			role = "user"
		case domainllm.TurnRoleAssistant:
			role = "assistant"
		default:
			return nil, fmt.Errorf("unsupported turn role: %s", turn.Role)
		}

		// Get content blocks for this turn.
		if len(turn.Blocks) == 0 {
			// Empty turn - skip it.
			mb.logger.Debug("skipping turn with no content blocks", "turn_id", turn.ID)
			continue
		}

		// Filter out dangling tool_use blocks (those without a corresponding tool_result).
		// This prevents 400 errors from providers when resuming interrupted conversations.
		validBlocks := mb.sanitizeTurnBlocks(turn)

		if len(validBlocks) == 0 {
			mb.logger.Debug("skipping turn after filtering dangling blocks", "turn_id", turn.ID)
			continue
		}

		// Apply collapse substitution: for turns before the collapse marker, replace
		// tool_result content with collapsed_content (if available).
		// This keeps context-window usage low for tool results we no longer need verbatim.
		if collapseMarkerIdx >= 0 && i < collapseMarkerIdx {
			validBlocks = mb.applyCollapseToBlocks(validBlocks)
		}

		// Convert []TurnBlock to []*TurnBlock, applying formatter to tool results.
		contentPtrs := make([]*domainllm.TurnBlock, len(validBlocks))
		for j := range validBlocks {
			// Apply formatting to tool results if needed.
			if validBlocks[j].BlockType == domainllm.BlockTypeToolResult {
				mb.formatToolResultBlock(&validBlocks[j])
			}
			contentPtrs[j] = &validBlocks[j]
		}

		messages = append(messages, domainllm.Message{
			Role:    role,
			Content: contentPtrs,
		})
	}

	// Optional: Inject token limit warning if last assistant turn is approaching limit.
	// TODO: Experiment with system prompt injection instead of user message
	if err := mb.injectTokenLimitWarningIfNeeded(path, &messages); err != nil {
		mb.logger.Debug("failed to inject token limit warning", "error", err)
		// Don't fail the request if warning injection fails
	}

	return messages, nil
}

// applyCollapseToBlocks substitutes collapsed_content into tool_result blocks that
// have it set. Returns a new slice with deep-copied content maps for modified blocks
// to avoid mutating the caller's turn data.
//
// Only tool_result blocks with a non-nil CollapsedContent are affected; all other
// block types are returned unchanged (same pointer references).
func (mb *MessageBuilderService) applyCollapseToBlocks(blocks []domainllm.TurnBlock) []domainllm.TurnBlock {
	result := make([]domainllm.TurnBlock, len(blocks))
	copy(result, blocks)

	for i := range result {
		block := &result[i]
		if block.BlockType != domainllm.BlockTypeToolResult || block.CollapsedContent == nil {
			continue
		}

		// Deep-copy the content map before mutating, since maps are reference types.
		// The original block's content map must not be modified (may be reused by callers).
		newContent := make(map[string]interface{}, len(block.Content))
		for k, v := range block.Content {
			newContent[k] = v
		}
		newContent["result"] = *block.CollapsedContent
		block.Content = newContent
	}

	return result
}

// formatToolResultBlock applies tool-specific formatting to a tool_result block's result field.
// This modifies the block in-place by replacing Content["result"] with the formatted version.
// Formatting happens on message build (not at storage time), so we keep full data in DB.
func (mb *MessageBuilderService) formatToolResultBlock(block *domainllm.TurnBlock) {
	formatting.FormatToolResultContent(mb.formatterRegistry, block.Content)
}

// injectTokenLimitWarningIfNeeded checks if the last assistant turn is approaching the token limit
// and injects a user message warning if usage is >75%
func (mb *MessageBuilderService) injectTokenLimitWarningIfNeeded(path []domainllm.Turn, messages *[]domainllm.Message) error {
	if len(path) == 0 {
		return nil
	}

	// Find the last assistant turn
	var lastAssistantTurn *domainllm.Turn
	for i := len(path) - 1; i >= 0; i-- {
		if path[i].Role == "assistant" {
			lastAssistantTurn = &path[i]
			break
		}
	}

	// No assistant turn found
	if lastAssistantTurn == nil {
		return nil
	}

	// Check if we have token usage data
	if lastAssistantTurn.InputTokens == nil || lastAssistantTurn.OutputTokens == nil {
		return nil
	}

	// Check if we have a model
	if lastAssistantTurn.Model == nil || *lastAssistantTurn.Model == "" {
		return nil
	}

	// Calculate total tokens
	totalTokens := *lastAssistantTurn.InputTokens + *lastAssistantTurn.OutputTokens

	// Determine provider
	provider := "anthropic" // default
	if lastAssistantTurn.RequestParams != nil {
		if providerParam, ok := lastAssistantTurn.RequestParams["provider"].(string); ok && providerParam != "" {
			provider = providerParam
		}
	}

	// Get model capability from registry
	modelCap, err := mb.capabilityRegistry.GetModelCapabilities(provider, *lastAssistantTurn.Model)
	if err != nil {
		// Model not in registry - skip warning
		return nil
	}

	// Calculate usage percentage
	if modelCap.ContextWindow <= 0 {
		return nil
	}

	usagePercent := (float64(totalTokens) / float64(modelCap.ContextWindow)) * 100

	// Inject warning if >75%
	if usagePercent > 75 {
		warningText := fmt.Sprintf("Note: You're approaching the context limit (%.1f%% used, %d/%d tokens). Consider wrapping up.", usagePercent, totalTokens, modelCap.ContextWindow)

		// Create a text block for the warning
		warningBlock := &domainllm.TurnBlock{
			BlockType: domainllm.BlockTypeText,
			Content: map[string]interface{}{
				"text": warningText,
			},
		}

		// Inject as user message
		*messages = append(*messages, domainllm.Message{
			Role:    "user",
			Content: []*domainllm.TurnBlock{warningBlock},
		})

		mb.logger.Debug("injected token limit warning",
			"usage_percent", usagePercent,
			"total_tokens", totalTokens,
			"context_limit", modelCap.ContextWindow,
		)
	}

	return nil
}

// sanitizeTurnBlocks handles dangling tool_use blocks in a turn.
// If a tool_use block has no corresponding tool_result (which can happen if the stream
// was interrupted), we inject a synthetic error tool_result to satisfy Claude's API
// requirement that every tool_use must have a corresponding tool_result.
func (mb *MessageBuilderService) sanitizeTurnBlocks(turn domainllm.Turn) []domainllm.TurnBlock {
	var validBlocks []domainllm.TurnBlock

	for i, block := range turn.Blocks {
		if block.BlockType == domainllm.BlockTypeToolUse {
			// Extract this tool's ID for matching
			thisToolUseID, _ := block.Content["tool_use_id"].(string)

			// Check if there is a subsequent tool_result block matching this tool_use_id
			hasResult := false
			for j := i + 1; j < len(turn.Blocks); j++ {
				if turn.Blocks[j].BlockType == domainllm.BlockTypeToolResult {
					// Check if this result matches our tool_use_id
					resultToolUseID, _ := turn.Blocks[j].Content["tool_use_id"].(string)
					if resultToolUseID == thisToolUseID {
						hasResult = true
						break
					}
				}
			}

			if !hasResult {
				mb.logger.Warn("injecting error tool_result for dangling tool_use block",
					"turn_id", turn.ID,
					"block_sequence", block.Sequence,
					"tool_name", block.Content["tool_name"])

				// Keep the tool_use block
				validBlocks = append(validBlocks, block)

				// Create synthetic error tool_result to satisfy Claude's API requirement
				// Extract tool_use_id and tool_name from the tool_use block
				toolUseID, _ := block.Content["tool_use_id"].(string)
				toolName, _ := block.Content["tool_name"].(string)

				errorResult := domainllm.TurnBlock{
					TurnID:    turn.ID,
					BlockType: domainllm.BlockTypeToolResult,
					Sequence:  block.Sequence + 1, // Immediately after the tool_use
					Content: map[string]interface{}{
						"tool_use_id": toolUseID,
						"tool_name":   toolName,
						"is_error":    true,
						"error":       "Tool execution was interrupted",
					},
				}
				validBlocks = append(validBlocks, errorResult)
				continue
			}
		}
		validBlocks = append(validBlocks, block)
	}

	return validBlocks
}
