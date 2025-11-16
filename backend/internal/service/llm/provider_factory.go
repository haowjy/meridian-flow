package llm

import (
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
	"github.com/haowjy/meridian-llm-go/providers/anthropic"
	"github.com/haowjy/meridian-llm-go/providers/lorem"

	"meridian/internal/config"
)

// ProviderFactory creates and manages LLM provider instances
type ProviderFactory struct {
	config *config.Config
}

// NewProviderFactory creates a new provider factory
func NewProviderFactory(cfg *config.Config) *ProviderFactory {
	return &ProviderFactory{
		config: cfg,
	}
}

// GetProvider returns a provider instance for the given provider name
//
// Supported providers:
//   - "anthropic" - Claude models via Anthropic API
//   - "lorem" - Mock provider for testing (no API key required)
//   - "openrouter" - Multiple providers via OpenRouter (future)
//   - "bedrock" - AWS Bedrock (future)
//   - "openai" - OpenAI models (future)
//   - "gemini" - Google Gemini models (future)
func (f *ProviderFactory) GetProvider(providerName string) (llmprovider.Provider, error) {
	switch providerName {
	case "anthropic":
		return f.createAnthropicProvider()

	case "lorem":
		return f.createLoremProvider()

	// Future providers:
	// case "openrouter":
	// 	return f.createOpenRouterProvider()
	// case "bedrock":
	// 	return f.createBedrockProvider()
	// case "openai":
	// 	return f.createOpenAIProvider()
	// case "gemini":
	// 	return f.createGeminiProvider()

	default:
		return nil, fmt.Errorf("unsupported provider: %s", providerName)
	}
}

// createAnthropicProvider creates an Anthropic provider instance
func (f *ProviderFactory) createAnthropicProvider() (llmprovider.Provider, error) {
	if f.config.AnthropicAPIKey == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY environment variable not set")
	}

	provider, err := anthropic.NewProvider(f.config.AnthropicAPIKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create Anthropic provider: %w", err)
	}

	return provider, nil
}

// createLoremProvider creates a Lorem mock provider instance
// Lorem requires no API key - it's a testing provider that generates lorem ipsum text
func (f *ProviderFactory) createLoremProvider() (llmprovider.Provider, error) {
	provider := lorem.NewProvider()
	return provider, nil
}

// Future provider creation methods:

// func (f *ProviderFactory) createOpenRouterProvider() (llmprovider.Provider, error) {
// 	if f.config.OpenRouterAPIKey == "" {
// 		return nil, fmt.Errorf("OPENROUTER_API_KEY environment variable not set")
// 	}
// 	return openrouter.NewProvider(f.config.OpenRouterAPIKey)
// }
//
// func (f *ProviderFactory) createBedrockProvider() (llmprovider.Provider, error) {
// 	// AWS Bedrock uses IAM credentials, not API keys
// 	return bedrock.NewProvider(f.config.AWSRegion, f.config.AWSProfile)
// }
//
// func (f *ProviderFactory) createOpenAIProvider() (llmprovider.Provider, error) {
// 	if f.config.OpenAIAPIKey == "" {
// 		return nil, fmt.Errorf("OPENAI_API_KEY environment variable not set")
// 	}
// 	return openai.NewProvider(f.config.OpenAIAPIKey)
// }
//
// func (f *ProviderFactory) createGeminiProvider() (llmprovider.Provider, error) {
// 	if f.config.GeminiAPIKey == "" {
// 		return nil, fmt.Errorf("GEMINI_API_KEY environment variable not set")
// 	}
// 	return gemini.NewProvider(f.config.GeminiAPIKey)
// }
