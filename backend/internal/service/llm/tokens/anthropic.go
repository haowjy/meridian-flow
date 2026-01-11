package tokens

import (
	"context"
	"fmt"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// AnthropicEstimator uses Anthropic's token counting API for accurate counts.
// This estimator makes an API call to count tokens, which is free but rate-limited.
type AnthropicEstimator struct {
	client *anthropic.Client
}

// NewAnthropicEstimator creates a new Anthropic token estimator.
// apiKey is the Anthropic API key used to authenticate with the token counting endpoint.
func NewAnthropicEstimator(apiKey string) (*AnthropicEstimator, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("anthropic API key is required for token estimation")
	}

	client := anthropic.NewClient(option.WithAPIKey(apiKey))

	return &AnthropicEstimator{
		client: &client,
	}, nil
}

// EstimateOutputTokens uses Anthropic's token counting API for accurate counts.
// The content is sent as an assistant message to count output tokens.
func (e *AnthropicEstimator) EstimateOutputTokens(ctx context.Context, model string, content string) (int, error) {
	if content == "" {
		return 0, nil
	}

	// Normalize OpenRouter model names to Anthropic API format
	// e.g., "anthropic/claude-3.5-sonnet" → "claude-3-5-sonnet-latest"
	apiModel := normalizeModelForAnthropicAPI(model)

	// Anthropic's count_tokens endpoint requires a valid model
	// We count the content as an assistant message to estimate output tokens
	resp, err := e.client.Messages.CountTokens(ctx, anthropic.MessageCountTokensParams{
		Model: anthropic.Model(apiModel),
		Messages: []anthropic.MessageParam{
			anthropic.NewAssistantMessage(anthropic.NewTextBlock(content)),
		},
	})
	if err != nil {
		return 0, fmt.Errorf("anthropic token count API failed: %w", err)
	}

	return int(resp.InputTokens), nil
}

// SupportsModel returns true for Claude models.
// Handles both direct Anthropic (claude-*) and OpenRouter-routed (anthropic/claude-*) models.
func (e *AnthropicEstimator) SupportsModel(model string) bool {
	// Direct Anthropic models: claude-3-5-sonnet-latest, claude-haiku-4-5, etc.
	// OpenRouter-routed: anthropic/claude-3.5-sonnet, anthropic/claude-3-opus, etc.
	return strings.HasPrefix(model, "claude-") || strings.Contains(model, "claude")
}

// normalizeModelForAnthropicAPI converts OpenRouter model names to Anthropic API format.
// OpenRouter uses different naming conventions that must be mapped to valid Anthropic model IDs.
func normalizeModelForAnthropicAPI(model string) string {
	// Strip "anthropic/" prefix if present (OpenRouter format)
	model = strings.TrimPrefix(model, "anthropic/")

	// Map common OpenRouter model names to Anthropic API names
	// OpenRouter uses "claude-3.5-sonnet", Anthropic uses "claude-3-5-sonnet-latest"
	switch {
	case strings.Contains(model, "claude-3.5-sonnet"):
		return "claude-3-5-sonnet-latest"
	case strings.Contains(model, "claude-3.5-haiku"):
		return "claude-3-5-haiku-latest"
	case strings.Contains(model, "claude-3-opus"):
		return "claude-3-opus-latest"
	case strings.Contains(model, "claude-3-sonnet"):
		return "claude-3-sonnet-20240229"
	case strings.Contains(model, "claude-3-haiku"):
		return "claude-3-haiku-20240307"
	default:
		// Return as-is for direct Anthropic model names
		return model
	}
}
