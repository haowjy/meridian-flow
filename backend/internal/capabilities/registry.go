package capabilities

import (
	"embed"
	"fmt"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed config/*.yaml
var configFiles embed.FS

// Registry manages model capabilities across all providers
type Registry struct {
	providers map[string]*ProviderCapabilities
	mu        sync.RWMutex
}

// NewRegistry creates a new capability registry and loads embedded YAML files
func NewRegistry() (*Registry, error) {
	r := &Registry{
		providers: make(map[string]*ProviderCapabilities),
	}

	// Load embedded YAML files
	if err := r.loadProviderFile("anthropic"); err != nil {
		return nil, fmt.Errorf("failed to load anthropic capabilities: %w", err)
	}

	if err := r.loadProviderFile("openrouter"); err != nil {
		return nil, fmt.Errorf("failed to load openrouter capabilities: %w", err)
	}

	return r, nil
}

// loadProviderFile loads a provider's capability YAML file
func (r *Registry) loadProviderFile(provider string) error {
	filename := fmt.Sprintf("config/%s.yaml", provider)
	data, err := configFiles.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("failed to read %s: %w", filename, err)
	}

	var providerCaps ProviderCapabilities
	if err := yaml.Unmarshal(data, &providerCaps); err != nil {
		return fmt.Errorf("failed to unmarshal %s: %w", filename, err)
	}

	r.mu.Lock()
	r.providers[provider] = &providerCaps
	r.mu.Unlock()

	return nil
}

// GetModelCapabilities returns capabilities for a specific model
func (r *Registry) GetModelCapabilities(provider, model string) (*ModelCapabilities, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	providerCaps, ok := r.providers[provider]
	if !ok {
		return nil, fmt.Errorf("unknown provider: %s", provider)
	}

	for i := range providerCaps.Models {
		if providerCaps.Models[i].ID == model {
			return &providerCaps.Models[i], nil
		}
	}

	return nil, fmt.Errorf("unknown model %s for provider %s", model, provider)
}

// ListProviderModels returns all models for a provider (ordered as defined in YAML)
func (r *Registry) ListProviderModels(provider string) ([]ModelCapabilities, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	providerCaps, ok := r.providers[provider]
	if !ok {
		return nil, fmt.Errorf("unknown provider: %s", provider)
	}

	return providerCaps.Models, nil
}

// GetAllProviders returns a list of all registered providers
func (r *Registry) GetAllProviders() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	providers := make([]string, 0, len(r.providers))
	for provider := range r.providers {
		providers = append(providers, provider)
	}
	return providers
}
