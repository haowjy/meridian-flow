package llm

import (
	"fmt"
	"strings"
)

// ModelInfo contains parsed provider and model information
type ModelInfo struct {
	Provider string // Provider name: "anthropic", "openrouter", "bedrock", "lorem"
	Model    string // Model identifier for that provider
}

// ParseModel extracts provider information from a model string
//
// Supported formats:
//   - "claude-haiku-4-5" → {Provider: "anthropic", Model: "claude-haiku-4-5"}
//   - "lorem-fast" → {Provider: "lorem", Model: "lorem-fast"}
//   - "openrouter/anthropic/claude-haiku-4-5" → {Provider: "openrouter", Model: "anthropic/claude-haiku-4-5"}
//   - "bedrock/claude-haiku-4-5" → {Provider: "bedrock", Model: "claude-haiku-4-5"}
//
// Rules:
//   - If model contains "/" → split on first "/" to extract provider
//   - Else → infer provider from model prefix
func ParseModel(modelStr string) (*ModelInfo, error) {
	if modelStr == "" {
		return nil, fmt.Errorf("model string cannot be empty")
	}

	// Check if provider is explicitly specified (contains "/")
	if strings.Contains(modelStr, "/") {
		parts := strings.SplitN(modelStr, "/", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid model format: %s (expected provider/model)", modelStr)
		}

		provider := parts[0]
		model := parts[1]

		if provider == "" {
			return nil, fmt.Errorf("provider cannot be empty in model string: %s", modelStr)
		}

		if model == "" {
			return nil, fmt.Errorf("model cannot be empty in model string: %s", modelStr)
		}

		return &ModelInfo{
			Provider: provider,
			Model:    model,
		}, nil
	}

	// Infer provider from model prefix
	provider := inferProvider(modelStr)
	if provider == "" {
		return nil, fmt.Errorf("unable to infer provider from model: %s", modelStr)
	}

	return &ModelInfo{
		Provider: provider,
		Model:    modelStr,
	}, nil
}

// inferProvider infers the provider from model name prefix
func inferProvider(model string) string {
	// Convert to lowercase for comparison
	modelLower := strings.ToLower(model)

	// Anthropic models
	if strings.HasPrefix(modelLower, "claude-") {
		return "anthropic"
	}

	// OpenAI models
	if strings.HasPrefix(modelLower, "gpt-") || strings.HasPrefix(modelLower, "o1-") {
		return "openai"
	}

	// Google models
	if strings.HasPrefix(modelLower, "gemini-") {
		return "gemini"
	}

	// Lorem mock provider (for testing)
	if strings.HasPrefix(modelLower, "lorem-") {
		return "lorem"
	}

	// Unknown provider
	return ""
}
