package streaming

import "meridian/internal/domain/llm"

// ProviderRegistry is the interface for getting LLM providers.
// This avoids import cycles with the parent llm package.
type ProviderRegistry interface {
	GetProvider(model string) (llm.LLMProvider, error)
}

// ProviderResolver delegates model->provider resolution to the shared registry.
type ProviderResolver struct {
	registry ProviderRegistry
}

// NewProviderResolver creates a provider resolver.
func NewProviderResolver(registry ProviderRegistry) *ProviderResolver {
	return &ProviderResolver{registry: registry}
}

// GetProvider gets an LLM provider by model name (delegates to registry).
func (r *ProviderResolver) GetProvider(model string) (llm.LLMProvider, error) {
	return r.registry.GetProvider(model)
}
