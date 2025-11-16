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

// GetProvider returns the provider for the given model string.
// Parses model to extract provider, creates provider via factory, wraps in adapter.
//
// Examples:
//   - "claude-haiku-4-5" → parses to "anthropic", creates Anthropic provider
//   - "lorem-fast" → parses to "lorem", creates Lorem provider (testing)
//   - "openrouter/anthropic/claude-haiku-4-5" → parses to "openrouter", creates OpenRouter provider
func (r *ProviderRegistry) GetProvider(model string) (domainllm.LLMProvider, error) {
	// Parse model to extract provider
	modelInfo, err := ParseModel(model)
	if err != nil {
		return nil, fmt.Errorf("failed to parse model string '%s': %w", model, err)
	}

	// Fast path: check cache with read lock (optimistic path for cache hits)
	r.mu.RLock()
	if cached, exists := r.cache[modelInfo.Provider]; exists {
		r.mu.RUnlock()
		return cached, nil
	}
	r.mu.RUnlock()

	// Slow path: create provider with write lock (prevents race conditions)
	r.mu.Lock()
	defer r.mu.Unlock()

	// Double-check cache after acquiring write lock
	// Another goroutine may have created the provider while we waited for the lock
	if cached, exists := r.cache[modelInfo.Provider]; exists {
		return cached, nil
	}

	// Create provider via factory (still holding write lock)
	libraryProvider, err := r.factory.GetProvider(modelInfo.Provider)
	if err != nil {
		return nil, fmt.Errorf("failed to create provider '%s': %w", modelInfo.Provider, err)
	}

	// Wrap in appropriate adapter based on provider type
	var adapter domainllm.LLMProvider
	switch modelInfo.Provider {
	case "lorem":
		adapter = adapters.NewLoremAdapterWithProvider(libraryProvider)
	case "anthropic":
		adapter = adapters.NewAnthropicAdapterWithProvider(libraryProvider)
	default:
		// Default to anthropic adapter for unknown providers
		// TODO: Create a generic adapter instead
		adapter = adapters.NewAnthropicAdapterWithProvider(libraryProvider)
	}

	// Cache for future use (still holding write lock)
	r.cache[modelInfo.Provider] = adapter

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
