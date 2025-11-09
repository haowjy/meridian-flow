package llm

import (
	"fmt"
	"strings"
	"sync"

	domainllm "meridian/internal/domain/services/llm"
)

// ProviderRegistry manages registered LLM providers and routes model requests to the appropriate provider.
type ProviderRegistry struct {
	providers map[string]domainllm.LLMProvider
	mu        sync.RWMutex
}

// NewProviderRegistry creates a new provider registry.
func NewProviderRegistry() *ProviderRegistry {
	return &ProviderRegistry{
		providers: make(map[string]domainllm.LLMProvider),
	}
}

// RegisterProvider registers a provider with the registry.
// Provider name is used as the key (e.g., "anthropic", "openai")
func (r *ProviderRegistry) RegisterProvider(provider domainllm.LLMProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[provider.Name()] = provider
}

// GetProvider returns the provider that supports the given model.
// Models are matched by prefix (e.g., "claude-*" → Anthropic, "gpt-*" → OpenAI)
func (r *ProviderRegistry) GetProvider(model string) (domainllm.LLMProvider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Try each registered provider to see if it supports the model
	for _, provider := range r.providers {
		if provider.SupportsModel(model) {
			return provider, nil
		}
	}

	// If no provider found, return detailed error
	availableProviders := make([]string, 0, len(r.providers))
	for name := range r.providers {
		availableProviders = append(availableProviders, name)
	}

	return nil, fmt.Errorf(
		"no provider found for model '%s'. Available providers: %s",
		model,
		strings.Join(availableProviders, ", "),
	)
}

// Validate ensures the registry has at least one provider registered.
// Should be called at startup to fail fast if misconfigured.
func (r *ProviderRegistry) Validate() error {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.providers) == 0 {
		return fmt.Errorf("no LLM providers registered")
	}

	return nil
}

// ListProviders returns a list of all registered provider names.
func (r *ProviderRegistry) ListProviders() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.providers))
	for name := range r.providers {
		names = append(names, name)
	}
	return names
}
