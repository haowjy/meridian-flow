package lorem

import (
	"context"
	"fmt"
	"strings"
	"time"

	loremgen "github.com/bozaro/golorem"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// Provider is a mock LLM provider that generates lorem ipsum text.
// Used for testing and development without requiring real API keys.
type Provider struct {
	generator *loremgen.Lorem
}

// NewProvider creates a new lorem ipsum provider.
func NewProvider() *Provider {
	return &Provider{
		generator: loremgen.New(),
	}
}

// Name returns the provider name.
func (p *Provider) Name() string {
	return "lorem"
}

// SupportsModel returns true if the model name starts with "lorem-".
// Example models: "lorem-fast", "lorem-slow", "lorem-test"
func (p *Provider) SupportsModel(model string) bool {
	return strings.HasPrefix(model, "lorem-")
}

// GenerateResponse generates a complete lorem ipsum response with a 10-second delay.
// This simulates a blocking API call to a real LLM provider.
func (p *Provider) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
	// Validate model
	if !p.SupportsModel(req.Model) {
		return nil, fmt.Errorf("model '%s' is not supported by lorem provider", req.Model)
	}

	// Extract parameters
	params := req.Params
	if params == nil {
		params = &llm.RequestParams{}
	}
	maxTokens := params.GetMaxTokens(4096)

	// Simulate 10-second processing delay
	select {
	case <-time.After(10 * time.Second):
		// Continue after delay
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	// Generate lorem ipsum text
	// Estimate: 1 token ≈ 4 characters
	targetChars := maxTokens * 4
	text := p.generateText(targetChars)

	// Estimate token counts (rough approximation)
	inputTokens := p.estimateTokens(req.Messages)
	outputTokens := len(strings.Fields(text)) // Word count as proxy

	// Create response
	return &domainllm.GenerateResponse{
		Content: []*llm.TurnBlock{
			{
				BlockType:   llm.BlockTypeText,
				TextContent: &text,
			},
		},
		Model:            req.Model,
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		StopReason:       "end_turn",
		ResponseMetadata: map[string]interface{}{
			"mock": true,
			"provider": "lorem",
		},
	}, nil
}

// getStreamDelay returns the delay between words based on the model name.
// - lorem-slow: 2 words/second (500ms per word)
// - lorem-fast: 30 words/second (33ms per word)
// - lorem-medium: 10 words/second (100ms per word)
// - default: 10 words/second
func getStreamDelay(model string) time.Duration {
	if strings.Contains(model, "slow") {
		return 500 * time.Millisecond // 2 words/second
	}
	if strings.Contains(model, "fast") {
		return 33 * time.Millisecond // 30 words/second
	}
	if strings.Contains(model, "medium") {
		return 100 * time.Millisecond // 10 words/second
	}
	return 100 * time.Millisecond // default: 10 words/second
}

// isCutoffModel returns true if the model should simulate max_tokens cutoff.
func isCutoffModel(model string) bool {
	return strings.Contains(model, "cutoff") || strings.Contains(model, "small")
}

// StreamResponse generates a streaming lorem ipsum response.
// Speed varies based on model name (lorem-slow, lorem-fast, lorem-medium).
// If thinking is enabled, emits a thinking block first, then a text block.
func (p *Provider) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Validate model
	if !p.SupportsModel(req.Model) {
		return nil, fmt.Errorf("model '%s' is not supported by lorem provider", req.Model)
	}

	// Extract parameters
	params := req.Params
	if params == nil {
		params = &llm.RequestParams{}
	}
	maxTokens := params.GetMaxTokens(4096)
	thinkingEnabled := params.ThinkingEnabled != nil && *params.ThinkingEnabled

	// Create buffered channel
	eventChan := make(chan domainllm.StreamEvent, 10)

	// Start streaming goroutine
	go func() {
		defer close(eventChan)

		blockIndex := 0
		totalOutputTokens := 0
		stopReason := "end_turn"

		// Optional thinking block
		if thinkingEnabled {
			if err := p.streamThinkingBlock(ctx, eventChan, blockIndex, req.Model); err != nil {
				eventChan <- domainllm.StreamEvent{Error: err}
				return
			}
			totalOutputTokens += 10 // ~10 words in thinking
			blockIndex++
		}

		// Main text block
		outputTokens, cutoff, err := p.streamTextBlock(ctx, eventChan, blockIndex, maxTokens-totalOutputTokens, req.Model)
		if err != nil {
			eventChan <- domainllm.StreamEvent{Error: err}
			return
		}
		totalOutputTokens += outputTokens
		if cutoff {
			stopReason = "max_tokens"
		}

		// Send final metadata
		inputTokens := p.estimateTokens(req.Messages)
		eventChan <- domainllm.StreamEvent{
			Metadata: &domainllm.StreamMetadata{
				Model:        req.Model,
				InputTokens:  inputTokens,
				OutputTokens: totalOutputTokens,
				StopReason:   stopReason,
				ResponseMetadata: map[string]interface{}{
					"mock": true,
					"provider": "lorem",
				},
			},
		}
	}()

	return eventChan, nil
}

// streamThinkingBlock streams a thinking block with ~10 words.
func (p *Provider) streamThinkingBlock(ctx context.Context, eventChan chan<- domainllm.StreamEvent, blockIndex int, model string) error {
	// Send block start
	eventChan <- domainllm.StreamEvent{
		Delta: &llm.TurnBlockDelta{
			BlockIndex: blockIndex,
			BlockType:  llm.BlockTypeThinking,
		},
	}

	// Generate thinking text (~10 words)
	thinkingText := p.generator.Sentence(8, 12)
	words := strings.Fields(thinkingText)

	// Get delay based on model
	delay := getStreamDelay(model)

	// Stream words with model-specific delay
	for _, word := range words {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		delta := word + " "
		eventChan <- domainllm.StreamEvent{
			Delta: &llm.TurnBlockDelta{
				BlockIndex: blockIndex,
				DeltaType:  llm.DeltaTypeTextDelta,
				TextDelta:  &delta,
			},
		}

		time.Sleep(delay)
	}

	return nil
}

// streamTextBlock streams a text block up to maxTokens words.
// Returns (word count, cutoff flag, error).
// For cutoff models, generates extra words and stops at maxTokens limit.
func (p *Provider) streamTextBlock(ctx context.Context, eventChan chan<- domainllm.StreamEvent, blockIndex int, maxTokens int, model string) (int, bool, error) {
	// Send block start
	eventChan <- domainllm.StreamEvent{
		Delta: &llm.TurnBlockDelta{
			BlockIndex: blockIndex,
			BlockType:  llm.BlockTypeText,
		},
	}

	// Determine target words
	targetWords := maxTokens
	cutoffModel := isCutoffModel(model)

	if cutoffModel {
		// Cutoff models generate 50% more to simulate hitting max_tokens
		targetWords = maxTokens + (maxTokens / 2)
	}

	// Generate paragraphs
	text := p.generateTextWords(targetWords)
	words := strings.Fields(text)

	// Get delay based on model
	delay := getStreamDelay(model)

	// Stream words with potential cutoff
	wordsSent := 0
	for _, word := range words {
		select {
		case <-ctx.Done():
			return wordsSent, false, ctx.Err()
		default:
		}

		// Check if we hit max_tokens limit
		if wordsSent >= maxTokens {
			// Cut off streaming
			return wordsSent, true, nil
		}

		delta := word + " "
		eventChan <- domainllm.StreamEvent{
			Delta: &llm.TurnBlockDelta{
				BlockIndex: blockIndex,
				DeltaType:  llm.DeltaTypeTextDelta,
				TextDelta:  &delta,
			},
		}

		time.Sleep(delay)
		wordsSent++
	}

	// If we sent all words without hitting limit, no cutoff
	return wordsSent, false, nil
}

// generateText generates lorem ipsum text with approximately targetChars characters.
func (p *Provider) generateText(targetChars int) string {
	var sb strings.Builder
	for sb.Len() < targetChars {
		paragraph := p.generator.Paragraph(3, 5)
		sb.WriteString(paragraph)
		sb.WriteString("\n\n")
	}
	return strings.TrimSpace(sb.String())
}

// generateTextWords generates lorem ipsum text with approximately targetWords words.
func (p *Provider) generateTextWords(targetWords int) string {
	var sb strings.Builder
	wordCount := 0

	for wordCount < targetWords {
		// Generate sentence with 5-15 words
		sentence := p.generator.Sentence(5, 15)
		sb.WriteString(sentence)
		sb.WriteString(" ")

		wordCount += len(strings.Fields(sentence))

		// Add paragraph break every ~50 words
		if wordCount%50 == 0 {
			sb.WriteString("\n\n")
		}
	}

	return strings.TrimSpace(sb.String())
}

// estimateTokens estimates the token count for a list of messages.
// Uses word count as a rough approximation.
func (p *Provider) estimateTokens(messages []domainllm.Message) int {
	totalWords := 0
	for _, msg := range messages {
		for _, block := range msg.Content {
			if block.TextContent != nil {
				words := len(strings.Fields(*block.TextContent))
				totalWords += words
			}
		}
	}
	return totalWords
}
