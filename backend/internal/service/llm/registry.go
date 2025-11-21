package llm

import (
	"fmt"
	"sync"

	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/adapters"
)

// ProviderRegistry manages LLM providers and routes model requests to the appropriate provider.
// Uses ModelParser to extract provider from model string, then ProviderFactory to create instances.
type ProviderRegistry struct {
	factory   *ProviderFactory
	cache     map[string]domainllm.LLMProvider // Cache provider instances
	mu        sync.RWMutex
}

// NewProviderRegistry creates a new provider registry.
func NewProviderRegistry(factory *ProviderFactory) *ProviderRegistry {
	return &ProviderRegistry{
		factory: factory,
		cache:   make(map[string]domainllm.LLMProvider),
	}
}

// GetProvider returns the provider adapter for the given provider name.
// Creates provider via factory, wraps in appropriate adapter, and caches for reuse.
//
// Examples:
//   - "anthropic" → creates Anthropic provider, wraps in AnthropicAdapter
//   - "openrouter" → creates OpenRouter provider, wraps in AnthropicAdapter
//   - "lorem" → creates Lorem provider, wraps in LoremAdapter
func (r *ProviderRegistry) GetProvider(provider string) (domainllm.LLMProvider, error) {
	if provider == "" {
		return nil, fmt.Errorf("provider cannot be empty")
	}

	// Fast path: check cache with read lock (optimistic path for cache hits)
	r.mu.RLock()
	if cached, exists := r.cache[provider]; exists {
		r.mu.RUnlock()
		return cached, nil
	}
	r.mu.RUnlock()

	// Slow path: create provider with write lock (prevents race conditions)
	r.mu.Lock()
	defer r.mu.Unlock()

	// Double-check cache after acquiring write lock
	// Another goroutine may have created the provider while we waited for the lock
	if cached, exists := r.cache[provider]; exists {
		return cached, nil
	}

	// Create provider via factory (still holding write lock)
	libraryProvider, err := r.factory.GetProvider(provider)
	if err != nil {
		return nil, fmt.Errorf("failed to create provider '%s': %w", provider, err)
	}

	// Wrap in appropriate adapter based on provider type
	var adapter domainllm.LLMProvider
	switch provider {
	case "lorem":
		adapter = adapters.NewLoremAdapterWithProvider(libraryProvider)
	case "anthropic":
		adapter = adapters.NewAnthropicAdapterWithProvider(libraryProvider)
	case "openrouter":
		adapter = adapters.NewOpenRouterAdapterWithProvider(libraryProvider)
	default:
		// Default to anthropic adapter for unknown providers
		// TODO: Create a generic adapter instead
		adapter = adapters.NewAnthropicAdapterWithProvider(libraryProvider)
	}

	// Cache for future use (still holding write lock)
	r.cache[provider] = adapter

	return adapter, nil
}

// Validate checks if the factory is properly configured.
// Should be called at startup to fail fast if misconfigured.
func (r *ProviderRegistry) Validate() error {
	if r.factory == nil {
		return fmt.Errorf("provider factory is not configured")
	}
	return nil
}
