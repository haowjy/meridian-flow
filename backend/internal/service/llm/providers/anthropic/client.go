package anthropic

import (
	"context"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/domain/models/llm"
)

// Provider implements the LLMProvider interface for Anthropic (Claude) models.
type Provider struct {
	client *anthropic.Client
}

// NewProvider creates a new Anthropic provider with the given API key.
func NewProvider(apiKey string) (*Provider, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("anthropic API key is required")
	}

	client := anthropic.NewClient(option.WithAPIKey(apiKey))

	return &Provider{
		client: &client,
	}, nil
}

// Name returns the provider name.
func (p *Provider) Name() string {
	return "anthropic"
}

// SupportsModel returns true if this provider supports the given model.
// Anthropic models start with "claude-"
func (p *Provider) SupportsModel(model string) bool {
	return strings.HasPrefix(model, "claude-")
}

// GenerateResponse generates a response from Claude.
func (p *Provider) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
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

	// Build request parameters with defaults
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

	// System prompt (from params or request)
	if params.System != nil {
		apiParams.System = []anthropic.TextBlockParam{
			{
				Type: "text",
				Text: *params.System,
			},
		}
	}

	// Thinking mode - convert user-friendly level to token budget
	if params.ThinkingEnabled != nil && *params.ThinkingEnabled {
		budgetTokens := params.GetThinkingBudgetTokens()
		if budgetTokens > 0 {
			// Use ThinkingConfigParamOfEnabled to create thinking config
			apiParams.Thinking = anthropic.ThinkingConfigParamOfEnabled(int64(budgetTokens))
		}
	}

	// Call Anthropic API
	message, err := p.client.Messages.New(ctx, apiParams)
	if err != nil {
		return nil, fmt.Errorf("anthropic API call failed: %w", err)
	}

	// Convert response to domain format with metadata
	response, err := convertFromAnthropicResponse(message)
	if err != nil {
		return nil, fmt.Errorf("failed to convert response: %w", err)
	}

	return response, nil
}
