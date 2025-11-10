package anthropic

import (
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// convertToAnthropicMessages converts domain messages to Anthropic SDK format.
func convertToAnthropicMessages(messages []domainllm.Message) ([]anthropic.MessageParam, error) {
	result := make([]anthropic.MessageParam, 0, len(messages))

	for i, msg := range messages {
		// Convert turn blocks to Anthropic ContentBlockParamUnion
		blocks := make([]anthropic.ContentBlockParamUnion, 0, len(msg.Content))

		for _, block := range msg.Content {
			switch block.BlockType {
			case llm.BlockTypeText:
				// Text block: use text_content field
				if block.TextContent == nil {
					return nil, fmt.Errorf("message %d: text block missing text_content", i)
				}
				blocks = append(blocks, anthropic.NewTextBlock(*block.TextContent))

			// Skip other block types for MVP (thinking, tool_result, image, etc.)
			// We'll add them as needed in future iterations
			}
		}

		// Create message based on role
		var message anthropic.MessageParam
		switch msg.Role {
		case "user":
			message = anthropic.NewUserMessage(blocks...)
		case "assistant":
			message = anthropic.NewAssistantMessage(blocks...)
		default:
			return nil, fmt.Errorf("message %d: unsupported role '%s'", i, msg.Role)
		}

		result = append(result, message)
	}

	return result, nil
}

// convertFromAnthropicResponse converts an Anthropic response to domain format.
func convertFromAnthropicResponse(msg *anthropic.Message) (*domainllm.GenerateResponse, error) {
	// Convert content blocks
	blocks := make([]*llm.TurnBlock, 0, len(msg.Content))

	for i, content := range msg.Content {
		var domainBlock *llm.TurnBlock

		// Check content type and extract appropriate fields
		switch content.Type {
		case "text":
			text := content.Text
			domainBlock = &llm.TurnBlock{
				BlockType:   llm.BlockTypeText,
				Sequence:    i,
				TextContent: &text,
				Content:     nil,
			}

		case "thinking":
			thinking := content.Thinking
			signature := content.Signature
			contentMap := make(map[string]interface{})
			if signature != "" {
				contentMap["signature"] = signature
			}
			domainBlock = &llm.TurnBlock{
				BlockType:   llm.BlockTypeThinking,
				Sequence:    i,
				TextContent: &thinking,
				Content:     contentMap,
			}

		// Skip other content types for MVP
		default:
			continue
		}

		if domainBlock != nil {
			blocks = append(blocks, domainBlock)
		}
	}

	// Build response metadata with provider-specific data
	responseMetadata := make(map[string]interface{})

	// Add stop sequence if present
	if msg.StopSequence != "" {
		responseMetadata["stop_sequence"] = msg.StopSequence
	}

	// Add cache token usage if present (Anthropic prompt caching)
	if msg.Usage.CacheCreationInputTokens > 0 {
		responseMetadata["cache_creation_input_tokens"] = int(msg.Usage.CacheCreationInputTokens)
	}
	if msg.Usage.CacheReadInputTokens > 0 {
		responseMetadata["cache_read_input_tokens"] = int(msg.Usage.CacheReadInputTokens)
	}

	return &domainllm.GenerateResponse{
		Content:          blocks,
		Model:            string(msg.Model),
		InputTokens:      int(msg.Usage.InputTokens),
		OutputTokens:     int(msg.Usage.OutputTokens),
		StopReason:       string(msg.StopReason),
		ResponseMetadata: responseMetadata,
	}, nil
}
