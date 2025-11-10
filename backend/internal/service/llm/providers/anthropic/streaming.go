package anthropic

import (
	"context"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// StreamResponse generates a streaming response from Claude.
// Returns a channel that emits StreamEvent as deltas arrive from the API.
func (p *Provider) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Validate model
	if !p.SupportsModel(req.Model) {
		return nil, fmt.Errorf("model '%s' is not supported by Anthropic provider", req.Model)
	}

	// Convert domain messages to Anthropic format
	messages, err := convertToAnthropicMessages(req.Messages)
	if err != nil {
		return nil, fmt.Errorf("failed to convert messages: %w", err)
	}

	// Extract params or use defaults
	params := req.Params
	if params == nil {
		params = &llm.RequestParams{}
	}

	// Build request parameters (same as GenerateResponse)
	maxTokens := int64(params.GetMaxTokens(4096))

	apiParams := anthropic.MessageNewParams{
		Model:     anthropic.Model(req.Model),
		Messages:  messages,
		MaxTokens: maxTokens,
	}

	// Temperature
	if params.Temperature != nil {
		apiParams.Temperature = anthropic.Float(*params.Temperature)
	}

	// Top-P
	if params.TopP != nil {
		apiParams.TopP = anthropic.Float(*params.TopP)
	}

	// Top-K
	if params.TopK != nil {
		apiParams.TopK = anthropic.Int(int64(*params.TopK))
	}

	// Stop sequences
	if len(params.Stop) > 0 {
		apiParams.StopSequences = params.Stop
	}

	// System prompt
	if params.System != nil {
		apiParams.System = []anthropic.TextBlockParam{
			{
				Type: "text",
				Text: *params.System,
			},
		}
	}

	// Thinking mode
	if params.ThinkingEnabled != nil && *params.ThinkingEnabled {
		budgetTokens := params.GetThinkingBudgetTokens()
		if budgetTokens > 0 {
			apiParams.Thinking = anthropic.ThinkingConfigParamOfEnabled(int64(budgetTokens))
		}
	}

	// Create streaming channel
	eventChan := make(chan domainllm.StreamEvent, 10) // Buffered to prevent blocking

	// Start streaming goroutine
	go func() {
		defer close(eventChan)

		// Call Anthropic streaming API
		stream := p.client.Messages.NewStreaming(ctx, apiParams)

		// Accumulator for final message metadata
		message := anthropic.Message{}

		// Iterate through streaming events
		for stream.Next() {
			event := stream.Current()

			// Accumulate event into final message
			if err := message.Accumulate(event); err != nil {
				eventChan <- domainllm.StreamEvent{
					Error: fmt.Errorf("failed to accumulate message: %w", err),
				}
				return
			}

			// Transform Anthropic event to domain StreamEvent
			streamEvent := transformAnthropicStreamEvent(event)

			// Send to channel (check context in case consumer cancelled)
			select {
			case <-ctx.Done():
				// Consumer cancelled, send error and exit
				eventChan <- domainllm.StreamEvent{
					Error: ctx.Err(),
				}
				return
			case eventChan <- streamEvent:
				// Successfully sent
			}
		}

		// Check for streaming errors
		if err := stream.Err(); err != nil {
			eventChan <- domainllm.StreamEvent{
				Error: fmt.Errorf("anthropic streaming error: %w", err),
			}
			return
		}

		// Send final message metadata
		metadata := &domainllm.StreamMetadata{
			Model:        string(message.Model),
			InputTokens:  int(message.Usage.InputTokens),
			OutputTokens: int(message.Usage.OutputTokens),
			StopReason:   string(message.StopReason),
		}

		// Build response metadata with provider-specific data
		responseMetadata := make(map[string]interface{})
		if message.StopSequence != "" {
			responseMetadata["stop_sequence"] = message.StopSequence
		}
		if message.Usage.CacheCreationInputTokens > 0 {
			responseMetadata["cache_creation_input_tokens"] = int(message.Usage.CacheCreationInputTokens)
		}
		if message.Usage.CacheReadInputTokens > 0 {
			responseMetadata["cache_read_input_tokens"] = int(message.Usage.CacheReadInputTokens)
		}
		metadata.ResponseMetadata = responseMetadata

		eventChan <- domainllm.StreamEvent{
			Metadata: metadata,
		}
	}()

	return eventChan, nil
}

// transformAnthropicStreamEvent converts an Anthropic streaming event to a domain StreamEvent.
//
// Anthropic stream events include:
// - MessageStart: Contains message metadata (id, model, role)
// - ContentBlockStart: New content block started (index, type)
// - ContentBlockDelta: Incremental content for current block (text_delta, input_json_delta)
// - ContentBlockStop: Current block finished
// - MessageDelta: Message-level delta (stop_reason, stop_sequence)
// - MessageStop: Streaming complete
func transformAnthropicStreamEvent(event anthropic.MessageStreamEventUnion) domainllm.StreamEvent {
	switch e := event.AsAny().(type) {
	case anthropic.MessageStartEvent:
		// MessageStart event - not needed for deltas, metadata comes at the end
		return domainllm.StreamEvent{} // Empty event, ignored by consumers

	case anthropic.ContentBlockStartEvent:
		// ContentBlockStart - emit block start delta
		delta := &llm.TurnBlockDelta{
			BlockIndex: int(e.Index),
			BlockType:  string(e.ContentBlock.Type),
		}

		// Extract block-specific initialization data
		switch e.ContentBlock.Type {
		case "thinking":
			if e.ContentBlock.Signature != "" {
				signature := e.ContentBlock.Signature
				delta.ThinkingSignature = &signature
			}

		case "tool_use":
			if e.ContentBlock.ID != "" {
				toolID := e.ContentBlock.ID
				delta.ToolUseID = &toolID
			}
			if e.ContentBlock.Name != "" {
				toolName := e.ContentBlock.Name
				delta.ToolName = &toolName
			}
		}

		return domainllm.StreamEvent{Delta: delta}

	case anthropic.ContentBlockDeltaEvent:
		// ContentBlockDelta - emit content delta
		delta := &llm.TurnBlockDelta{
			BlockIndex: int(e.Index),
		}

		// Extract delta based on type
		switch e.Delta.Type {
		case "text_delta":
			delta.DeltaType = llm.DeltaTypeTextDelta
			text := e.Delta.Text
			delta.TextDelta = &text

		case "input_json_delta":
			delta.DeltaType = llm.DeltaTypeInputJSONDelta
			jsonDelta := e.Delta.PartialJSON
			delta.InputJSONDelta = &jsonDelta
		}

		return domainllm.StreamEvent{Delta: delta}

	case anthropic.ContentBlockStopEvent:
		// ContentBlockStop - not needed, block completion handled by BlockAccumulator
		return domainllm.StreamEvent{} // Empty event

	case anthropic.MessageDeltaEvent:
		// MessageDelta - contains stop_reason, handled in FinalMessage
		return domainllm.StreamEvent{} // Empty event

	case anthropic.MessageStopEvent:
		// MessageStop - final metadata sent after stream.Next() completes
		return domainllm.StreamEvent{} // Empty event

	default:
		// Unknown event type - log warning but don't fail
		// TODO: Add structured logging
		return domainllm.StreamEvent{} // Empty event
	}
}
