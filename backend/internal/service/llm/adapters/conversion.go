package adapters

import (
	llmprovider "github.com/haowjy/meridian-llm-go"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// convertToLibraryRequest converts backend GenerateRequest to library GenerateRequest
func convertToLibraryRequest(req *domainllm.GenerateRequest) *llmprovider.GenerateRequest {
	messages := make([]llmprovider.Message, len(req.Messages))
	for i, msg := range req.Messages {
		blocks := make([]*llmprovider.Block, len(msg.Content))
		for j, tb := range msg.Content {
			blocks[j] = &llmprovider.Block{
				BlockType:   tb.BlockType,
				Sequence:    tb.Sequence,
				TextContent: tb.TextContent,
				Content:     tb.Content,
			}
		}
		messages[i] = llmprovider.Message{
			Role:   msg.Role,
			Blocks: blocks,
		}
	}

	return &llmprovider.GenerateRequest{
		Messages: messages,
		Model:    req.Model,
		Params:   convertToLibraryParams(req.Params),
	}
}

// convertFromLibraryResponse converts library GenerateResponse to backend GenerateResponse
func convertFromLibraryResponse(resp *llmprovider.GenerateResponse) *domainllm.GenerateResponse {
	blocks := make([]*llm.TurnBlock, len(resp.Blocks))
	for i, block := range resp.Blocks {
		blocks[i] = &llm.TurnBlock{
			// ID, TurnID, CreatedAt will be added by repository layer
			BlockType:   block.BlockType,
			Sequence:    block.Sequence,
			TextContent: block.TextContent,
			Content:     block.Content,
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
			InputJSONDelta:    event.Delta.InputJSONDelta,
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
func convertToLibraryParams(params *llm.RequestParams) *llmprovider.RequestParams {
	if params == nil {
		return nil
	}

	return &llmprovider.RequestParams{
		MaxTokens:       params.MaxTokens,
		Temperature:     params.Temperature,
		TopP:            params.TopP,
		TopK:            params.TopK,
		Stop:            params.Stop,
		System:          params.System,
		ThinkingEnabled: params.ThinkingEnabled,
		ThinkingLevel:   params.ThinkingLevel,
	}
}
