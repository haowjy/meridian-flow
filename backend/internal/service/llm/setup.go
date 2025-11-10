package llm

import (
	"fmt"
	"log/slog"

	"meridian/internal/config"
	"meridian/internal/service/llm/providers/anthropic"
	"meridian/internal/service/llm/providers/lorem"
)

// SetupProviders initializes and registers all configured LLM providers.
// Returns a configured ProviderRegistry or an error if setup fails.
func SetupProviders(cfg *config.Config, logger *slog.Logger) (*ProviderRegistry, error) {
	registry := NewProviderRegistry()

	// Register Anthropic provider (if API key is configured)
	if cfg.AnthropicAPIKey != "" {
		anthropicProvider, err := anthropic.NewProvider(cfg.AnthropicAPIKey)
		if err != nil {
			return nil, fmt.Errorf("failed to create Anthropic provider: %w", err)
		}
		registry.RegisterProvider(anthropicProvider)
		logger.Info("provider registered", "name", "anthropic", "models", "claude-*")
	} else {
		logger.Warn("ANTHROPIC_API_KEY not set - Anthropic provider not available")
	}

	// Register Lorem provider (mock - dev/test only)
	if cfg.Environment == "dev" || cfg.Environment == "test" {
		loremProvider := lorem.NewProvider()
		registry.RegisterProvider(loremProvider)
		logger.Warn("provider registered (MOCK)",
			"name", "lorem",
			"models", "lorem-*",
			"warning", "Lorem provider is for testing only - not for production!")
	}

	// Future providers: OpenAI, Google, OpenRouter, etc.
	// if cfg.OpenAIAPIKey != "" { ... }

	// Validate registry has at least one provider
	if err := registry.Validate(); err != nil {
		return nil, fmt.Errorf("provider registry validation failed: %w", err)
	}

	return registry, nil
}
