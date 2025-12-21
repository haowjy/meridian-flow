package conversation

import (
	"context"
	"fmt"
	"log/slog"

	"meridian/internal/capabilities"
	domainllm "meridian/internal/domain/services/llm"
	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/service/llm/formatting"
)

// MessageBuilderService converts conversation history (database turns) to LLM messages.
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
func (mb *MessageBuilderService) BuildMessages(
	ctx context.Context,
	path []llmModels.Turn,
) ([]domainllm.Message, error) {
	messages := make([]domainllm.Message, 0, len(path))

	for _, turn := range path {
		// Determine role
		var role string
		switch turn.Role {
		case "user":
			role = "user"
		case "assistant":
			role = "assistant"
		default:
			return nil, fmt.Errorf("unsupported turn role: %s", turn.Role)
		}

		// Get content blocks for this turn
		if len(turn.Blocks) == 0 {
			// Empty turn - skip it
			mb.logger.Warn("skipping turn with no content blocks", "turn_id", turn.ID)
			continue
		}

		// Filter out dangling tool_use blocks (those without a corresponding tool_result)
		// This prevents 400 errors from providers when resuming interrupted conversations
		validBlocks := mb.sanitizeTurnBlocks(turn)

		if len(validBlocks) == 0 {
			mb.logger.Warn("skipping turn after filtering dangling blocks", "turn_id", turn.ID)
			continue
		}

		// Convert []TurnBlock to []*TurnBlock
		contentPtrs := make([]*llmModels.TurnBlock, len(validBlocks))
		for i := range validBlocks {
			// Apply formatting to tool results if needed
			if validBlocks[i].BlockType == llmModels.BlockTypeToolResult {
				mb.formatToolResultBlock(&validBlocks[i])
			}
			contentPtrs[i] = &validBlocks[i]
		}

		messages = append(messages, domainllm.Message{
			Role:    role,
			Content: contentPtrs,
		})
	}

	// Optional: Inject token limit warning if last assistant turn is approaching limit
	// TODO: Experiment with system prompt injection instead of user message
	if err := mb.injectTokenLimitWarningIfNeeded(path, &messages); err != nil {
		mb.logger.Warn("failed to inject token limit warning", "error", err)
		// Don't fail the request if warning injection fails
	}

	return messages, nil
}

// formatToolResultBlock applies tool-specific formatting to a tool_result block's result field.
// This modifies the block in-place by replacing Content["result"] with the formatted version.
// Formatting happens on message build (not at storage time), so we keep full data in DB.
func (mb *MessageBuilderService) formatToolResultBlock(block *llmModels.TurnBlock) {
	// Defensive: ensure formatter registry and block content exist
	if mb.formatterRegistry == nil {
		return
	}
	if block.Content == nil {
		return
	}

	// Extract tool_name from block content
	toolName, ok := block.Content["tool_name"].(string)
	if !ok || toolName == "" {
		// No tool name - can't format
		return
	}

	// Extract result from block content
	result, ok := block.Content["result"]
	if !ok {
		// No result to format (might be error or already formatted)
		return
	}

	// Apply formatting
	formattedResult := mb.formatterRegistry.Format(toolName, result)

	// Replace result with formatted version in-place
	block.Content["result"] = formattedResult
}

// injectTokenLimitWarningIfNeeded checks if the last assistant turn is approaching the token limit
// and injects a user message warning if usage is >75%
func (mb *MessageBuilderService) injectTokenLimitWarningIfNeeded(path []llmModels.Turn, messages *[]domainllm.Message) error {
	if len(path) == 0 {
		return nil
	}

	// Find the last assistant turn
	var lastAssistantTurn *llmModels.Turn
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
		warningBlock := &llmModels.TurnBlock{
			BlockType: llmModels.BlockTypeText,
			Content: map[string]interface{}{
				"text": warningText,
			},
		}

		// Inject as user message
		*messages = append(*messages, domainllm.Message{
			Role:    "user",
			Content: []*llmModels.TurnBlock{warningBlock},
		})

		mb.logger.Info("injected token limit warning",
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
func (mb *MessageBuilderService) sanitizeTurnBlocks(turn llmModels.Turn) []llmModels.TurnBlock {
	var validBlocks []llmModels.TurnBlock

	for i, block := range turn.Blocks {
		if block.BlockType == llmModels.BlockTypeToolUse {
			// Extract this tool's ID for matching
			thisToolUseID, _ := block.Content["tool_use_id"].(string)

			// Check if there is a subsequent tool_result block matching this tool_use_id
			hasResult := false
			for j := i + 1; j < len(turn.Blocks); j++ {
				if turn.Blocks[j].BlockType == llmModels.BlockTypeToolResult {
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

				errorResult := llmModels.TurnBlock{
					TurnID:    turn.ID,
					BlockType: llmModels.BlockTypeToolResult,
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
