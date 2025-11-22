package adapters

import (
	"encoding/json"
	"strings"

	llmprovider "github.com/haowjy/meridian-llm-go"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// normalizeToolResultContent converts tool result content to string format.
// If result is already a string (from formatters like doc_tree), use directly.
// If result is structured data (maps/arrays), JSON-marshal it for LLM consumption.
// This normalization happens at the backend-library boundary so adapters can
// assume Content["result"] is always a string (Single Responsibility Principle).
func normalizeToolResultContent(content map[string]interface{}) {
	if content == nil {
		return
	}

	// Only normalize tool_result content that has a "result" field
	result, hasResult := content["result"]
	if !hasResult {
		return
	}

	// If already a string (from formatters), keep as-is
	if _, ok := result.(string); ok {
		return
	}

	// Structured data - marshal to pretty JSON for LLM readability
	resultJSON, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		// Fallback: keep original if marshaling fails
		// This ensures we don't break existing functionality
		return
	}

	// Replace with JSON string
	content["result"] = string(resultJSON)
}

// ConvertToLibraryRequest converts backend GenerateRequest to library GenerateRequest.
// This is used by provider adapters and debug tooling to inspect the exact payload
// that will be sent to the underlying meridian-llm-go provider.
func ConvertToLibraryRequest(req *domainllm.GenerateRequest) (*llmprovider.GenerateRequest, error) {
	messages := make([]llmprovider.Message, len(req.Messages))
	for i, msg := range req.Messages {
		blocks := make([]*llmprovider.Block, len(msg.Content))
		for j, tb := range msg.Content {
			// Convert ExecutionSide from backend type (*string) to library type (*llmprovider.ExecutionSide)
			var executionSide *llmprovider.ExecutionSide
			if tb.ExecutionSide != nil {
				side := llmprovider.ExecutionSide(*tb.ExecutionSide)
				executionSide = &side
			}

			// Normalize tool_result blocks: convert Content["result"] to string
			// This prevents double JSON-encoding in provider adapters
			if tb.BlockType == llm.BlockTypeToolResult {
				normalizeToolResultContent(tb.Content)
			}

			blocks[j] = &llmprovider.Block{
				BlockType:     tb.BlockType,
				Sequence:      tb.Sequence,
				TextContent:   tb.TextContent,
				Content:       tb.Content,
				Provider:      tb.Provider,
				ProviderData:  tb.ProviderData, // Direct copy of raw bytes - no marshal
				ExecutionSide: executionSide,
			}
		}
		messages[i] = llmprovider.Message{
			Role:   msg.Role,
			Blocks: blocks,
		}
	}

	// Convert request params (includes tool conversion via ToLibraryTools)
	convertedParams, err := convertToLibraryParams(req.Params, req.Model)
	if err != nil {
		return nil, err
	}

	return &llmprovider.GenerateRequest{
		Messages: messages,
		Model:    req.Model,
		Params:   convertedParams,
	}, nil
}

// convertFromLibraryResponse converts library GenerateResponse to backend GenerateResponse
func convertFromLibraryResponse(resp *llmprovider.GenerateResponse) *domainllm.GenerateResponse {
	blocks := make([]*llm.TurnBlock, len(resp.Blocks))
	for i, block := range resp.Blocks {
		// Convert ExecutionSide from library type (*llmprovider.ExecutionSide) to *string
		var executionSide *string
		if block.ExecutionSide != nil {
			side := string(*block.ExecutionSide)
			executionSide = &side
		}

		blocks[i] = &llm.TurnBlock{
			// ID, TurnID, CreatedAt will be added by repository layer
			BlockType:     block.BlockType,
			Sequence:      block.Sequence,
			TextContent:   block.TextContent,
			Content:       block.Content,
			Provider:      block.Provider,
			ProviderData:  block.ProviderData, // Direct copy of raw bytes - no unmarshal
			ExecutionSide: executionSide,
		}
	}

	return &domainllm.GenerateResponse{
		Content:          blocks,
		Model:            resp.Model,
		InputTokens:      resp.InputTokens,
		OutputTokens:     resp.OutputTokens,
		StopReason:       resp.StopReason,
		ResponseMetadata: resp.ResponseMetadata,
	}
}

// convertFromLibraryEvent converts library StreamEvent to backend StreamEvent
func convertFromLibraryEvent(event llmprovider.StreamEvent) domainllm.StreamEvent {
	backendEvent := domainllm.StreamEvent{
		Error: event.Error,
	}

	if event.Delta != nil {
		backendEvent.Delta = &llm.TurnBlockDelta{
			BlockIndex:        event.Delta.BlockIndex,
			BlockType:         event.Delta.BlockType,
			DeltaType:         event.Delta.DeltaType,
			TextDelta:         event.Delta.TextDelta,
			SignatureDelta:    event.Delta.SignatureDelta,
			JSONDelta:         event.Delta.JSONDelta,
			ToolCallID:        event.Delta.ToolCallID,
			ToolCallName:      event.Delta.ToolCallName,
			ToolUseID:         event.Delta.ToolUseID,         // Legacy
			ToolName:          event.Delta.ToolName,          // Legacy
			ThinkingSignature: event.Delta.ThinkingSignature, // Legacy
			InputTokens:       event.Delta.InputTokens,
			OutputTokens:      event.Delta.OutputTokens,
			ThinkingTokens:    event.Delta.ThinkingTokens,
		}
	}

	if event.Block != nil {
		// Convert ExecutionSide from library type (*llmprovider.ExecutionSide) to *string
		var executionSide *string
		if event.Block.ExecutionSide != nil {
			side := string(*event.Block.ExecutionSide)
			executionSide = &side
		}

		backendEvent.Block = &llm.TurnBlock{
			// ID, TurnID, CreatedAt will be added by repository layer or executor
			BlockType:     event.Block.BlockType,
			Sequence:      event.Block.Sequence,
			TextContent:   event.Block.TextContent,
			Content:       event.Block.Content,
			Provider:      event.Block.Provider,
			ProviderData:  event.Block.ProviderData, // Direct copy of raw bytes - no unmarshal
			ExecutionSide: executionSide,
		}
	}

	if event.Metadata != nil {
		backendEvent.Metadata = &domainllm.StreamMetadata{
			Model:            event.Metadata.Model,
			InputTokens:      event.Metadata.InputTokens,
			OutputTokens:     event.Metadata.OutputTokens,
			StopReason:       event.Metadata.StopReason,
			ResponseMetadata: event.Metadata.ResponseMetadata,
		}
	}

	return backendEvent
}

// convertToLibraryParams converts backend RequestParams to library RequestParams
// For lorem models, applies lorem_max override if set (debug/testing feature)
// Converts ToolDefinition[] to library Tool[] using constructors (NewCustomTool, MapToolByName)
func convertToLibraryParams(params *llm.RequestParams, model string) (*llmprovider.RequestParams, error) {
	if params == nil {
		return nil, nil
	}

	// Convert backend ToolDefinitions to library Tools using constructors
	var libraryTools []llmprovider.Tool
	if len(params.Tools) > 0 {
		convertedTools, err := llm.ToLibraryTools(params.Tools)
		if err != nil {
			return nil, err
		}
		libraryTools = convertedTools
	}

	libParams := &llmprovider.RequestParams{
		MaxTokens:       params.MaxTokens,
		Temperature:     params.Temperature,
		TopP:            params.TopP,
		TopK:            params.TopK,
		Stop:            params.Stop,
		System:          params.System,
		ThinkingEnabled: params.ThinkingEnabled,
		ThinkingLevel:   params.ThinkingLevel,
		Tools:           libraryTools,      // Converted from ToolDefinition[]
		ToolChoice:      params.ToolChoice, // Direct copy (same library type)
	}

	// Apply lorem_max override for lorem models (debug/testing feature)
	// If lorem_max is set, use it instead of max_tokens to control output length
	// This allows quick testing of streaming/interruption without waiting for large responses
	if params.LoremMax != nil && strings.HasPrefix(strings.ToLower(model), "lorem-") {
		libParams.MaxTokens = params.LoremMax
	}

	return libParams, nil
}
