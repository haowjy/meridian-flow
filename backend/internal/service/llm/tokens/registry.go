package tokens

import (
	"context"
	"sync"
)

// TokenCounterRegistry manages token counters and selects the appropriate one.
// Follows Open/Closed Principle: add new token counters without modifying existing code.
//
// The registry checks token counters in order of registration - register more specific
// counters first (e.g., Anthropic).
//
// Note: OpenRouter models should use the Generation Stats API instead of token counting.
// The token counter is primarily for Anthropic direct API calls.
type TokenCounterRegistry struct {
	counters []TokenCounter
	mu       sync.RWMutex
}

// NewTokenCounterRegistry creates a new token counter registry.
// Unlike before, there is no fallback - unsupported models return 0 tokens.
// OpenRouter models should use the Generation Stats API instead.
func NewTokenCounterRegistry() *TokenCounterRegistry {
	return &TokenCounterRegistry{
		counters: make([]TokenCounter, 0),
	}
}

// Register adds a token counter to the registry.
// Token counters are checked in order - register more specific ones first.
//
// Example registration order:
//  1. AnthropicTokenCounter (specific: handles claude-* models)
//  2. Other provider counters (if added in the future)
func (r *TokenCounterRegistry) Register(c TokenCounter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.counters = append(r.counters, c)
}

// CountOutputTokens finds the appropriate token counter and counts tokens.
// Returns (0, nil) if content is empty or no token counter supports the model.
//
// Selection logic:
//  1. Find first registered token counter that supports the model
//  2. If no counter found, return 0 (caller should use provider-specific API like OpenRouter Generation Stats)
func (r *TokenCounterRegistry) CountOutputTokens(ctx context.Context, model string, content string) (int, error) {
	if content == "" {
		return 0, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	// Find first token counter that supports this model
	for _, c := range r.counters {
		if c.SupportsModel(model) {
			return c.CountOutputTokens(ctx, model, content)
		}
	}

	// No token counter found - return 0
	// Caller should use provider-specific API (e.g., OpenRouter Generation Stats)
	return 0, nil
}

// SupportsModel returns true if any registered token counter supports the model.
func (r *TokenCounterRegistry) SupportsModel(model string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, c := range r.counters {
		if c.SupportsModel(model) {
			return true
		}
	}
	return false
}
