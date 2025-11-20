package llm

import "strings"

// GetProviderForModel returns the provider for a given model name based on common prefixes.
// Returns (provider, true) if a mapping is found, ("", false) if not.
//
// This is used as fallback when provider is not explicitly specified.
// If no mapping is found, caller should default to "openrouter".
func GetProviderForModel(model string) (string, bool) {
	if model == "" {
		return "", false
	}

	// Convert to lowercase for case-insensitive matching
	modelLower := strings.ToLower(model)

	// Anthropic Claude models
	if strings.HasPrefix(modelLower, "claude-") {
		return "anthropic", true
	}

	// OpenAI models
	if strings.HasPrefix(modelLower, "gpt-") || strings.HasPrefix(modelLower, "o1-") ||
	   strings.HasPrefix(modelLower, "text-") || strings.HasPrefix(modelLower, "davinci-") {
		return "openai", true
	}

	// Google Gemini models
	if strings.HasPrefix(modelLower, "gemini-") {
		return "google", true
	}

	// Lorem mock provider (for testing)
	if strings.HasPrefix(modelLower, "lorem-") {
		return "lorem", true
	}

	// No mapping found
	return "", false
}
