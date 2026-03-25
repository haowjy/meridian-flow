// Package tokens provides token counting and estimation for LLM requests.
// This file implements TokenEstimator: a tiktoken-based pre-flight estimator
// for context budget tracking (autocollapse at 60%, autocompact at 80%).
package tokens

import (
	"context"
	"fmt"
	"sort"

	tiktoken "github.com/pkoukk/tiktoken-go"

	"meridian/internal/capabilities"
)

// Message is a simplified message representation for token estimation.
// Role is the speaker role (e.g. "user", "assistant", "tool_result").
type Message struct {
	Role    string
	Content string
}

// Tool is a simplified tool definition for token estimation.
// InputSchema should be the JSON-encoded schema string (may be empty).
type Tool struct {
	Name        string
	Description string
	InputSchema string // JSON string; included verbatim in the token count
}

// EstimateRequest carries the inputs for a full token estimation.
// Model is the model ID used to look up ContextWindow and MaxOutput
// from the CapabilityRegistry (searched across all providers).
type EstimateRequest struct {
	Model        string
	SystemPrompt string
	Messages     []Message
	Tools        []Tool
}

// TokenEstimate holds the result of a pre-flight token estimation.
// All counts are approximate (±5% from actual) when using tiktoken.
type TokenEstimate struct {
	SystemTokens   int
	MessageTokens  int
	ToolTokens     int
	TotalInput     int
	ContextWindow  int     // from CapabilityRegistry; 0 if model unknown
	MaxOutput      int     // from CapabilityRegistry; 0 if model unknown
	RemainingInput int     // ContextWindow - TotalInput - MaxOutput
	UsagePercent   float64 // TotalInput / (ContextWindow - MaxOutput); 0 if denominator ≤ 0. Values greater than 1.0 indicate the input exceeds available context budget.
}

// TokenEstimator estimates token usage for LLM requests without making API calls.
// Implementations must be safe for concurrent use from multiple goroutines.
type TokenEstimator interface {
	// EstimateRequest returns a full token budget breakdown for the given request.
	EstimateRequest(ctx context.Context, req EstimateRequest) (*TokenEstimate, error)

	// EstimateText returns the token count for an arbitrary string.
	EstimateText(text string) int
}

// messagePaddingTokens is the per-message overhead added to account for
// message boundary markers in the ChatML-like format used by cl100k_base models.
// 4 tokens matches OpenAI's documented overhead; acceptable for ±5% estimation.
const messagePaddingTokens = 4

// tiktokenEstimator implements TokenEstimator using tiktoken-go cl100k_base encoding.
// A single encoding is shared across all model families — 5% variance is acceptable
// for the 60%/80% context-management thresholds that consume these estimates.
//
// Thread-safe: tiktoken.Tiktoken is safe for concurrent Encode calls.
type tiktokenEstimator struct {
	enc         *tiktoken.Tiktoken
	capRegistry *capabilities.Registry // may be nil; skips capability lookup if so
}

// NewTiktokenEstimator creates a token estimator backed by tiktoken cl100k_base encoding.
// capRegistry is used for ContextWindow/MaxOutput lookups; pass nil to skip (estimates
// will have ContextWindow=0, MaxOutput=0, UsagePercent=0).
// Returns the TokenEstimator interface so callers are decoupled from the concrete type.
func NewTiktokenEstimator(capRegistry *capabilities.Registry) (TokenEstimator, error) {
	enc, err := tiktoken.GetEncoding("cl100k_base")
	if err != nil {
		return nil, fmt.Errorf("failed to load cl100k_base encoding: %w", err)
	}
	return &tiktokenEstimator{
		enc:         enc,
		capRegistry: capRegistry,
	}, nil
}

// EstimateText returns the token count for a raw string using cl100k_base encoding.
// Returns 0 for an empty string.
func (e *tiktokenEstimator) EstimateText(text string) int {
	if text == "" {
		return 0
	}
	return len(e.enc.Encode(text, nil, nil))
}

// EstimateRequest computes a full token budget breakdown for the given request.
//
// Token accounting:
//   - SystemTokens: raw token count of the system prompt
//   - MessageTokens: sum of (role + content + messagePaddingTokens) for each message
//   - ToolTokens: sum of (name + description + input_schema) for each tool definition
//   - TotalInput = SystemTokens + MessageTokens + ToolTokens
//
// ContextWindow and MaxOutput are looked up from the CapabilityRegistry by searching
// all providers for the given model ID. Unknown models return 0 for both fields.
//
// RemainingInput = ContextWindow - TotalInput - MaxOutput
// UsagePercent   = TotalInput / (ContextWindow - MaxOutput)   (0 if denominator ≤ 0)
func (e *tiktokenEstimator) EstimateRequest(_ context.Context, req EstimateRequest) (*TokenEstimate, error) {
	systemTokens := e.EstimateText(req.SystemPrompt)

	// Each message incurs padding tokens for the message boundary in addition to its content.
	messageTokens := 0
	for _, msg := range req.Messages {
		messageTokens += e.EstimateText(msg.Role) + e.EstimateText(msg.Content) + messagePaddingTokens
	}

	// Tools are counted as the concatenation of their name, description, and schema.
	// Actual Anthropic tool encoding adds some JSON framing, but the straight sum
	// is within the ±5% tolerance required for threshold-based triggering.
	toolTokens := 0
	for _, tool := range req.Tools {
		toolTokens += e.EstimateText(tool.Name) + e.EstimateText(tool.Description) + e.EstimateText(tool.InputSchema)
	}

	totalInput := systemTokens + messageTokens + toolTokens

	contextWindow, maxOutput := e.lookupModelCapabilities(req.Model)

	remainingInput := contextWindow - totalInput - maxOutput

	// Guard against zero or negative denominator (unknown model or model where
	// MaxOutput ≥ ContextWindow, which should not happen in practice).
	var usagePercent float64
	if denominator := contextWindow - maxOutput; denominator > 0 {
		usagePercent = float64(totalInput) / float64(denominator)
	}

	return &TokenEstimate{
		SystemTokens:   systemTokens,
		MessageTokens:  messageTokens,
		ToolTokens:     toolTokens,
		TotalInput:     totalInput,
		ContextWindow:  contextWindow,
		MaxOutput:      maxOutput,
		RemainingInput: remainingInput,
		UsagePercent:   usagePercent,
	}, nil
}

// lookupModelCapabilities searches all registered providers for the given model ID
// and returns its ContextWindow and MaxOutput values.
// Returns (0, 0) if the model is not found in any provider or the registry is nil.
//
// Providers are iterated in sorted order to guarantee deterministic results when
// the same model ID appears under multiple providers with different capabilities.
func (e *tiktokenEstimator) lookupModelCapabilities(model string) (contextWindow, maxOutput int) {
	if e.capRegistry == nil || model == "" {
		return 0, 0
	}
	providers := e.capRegistry.GetAllProviders()
	sort.Strings(providers)
	for _, provider := range providers {
		caps, err := e.capRegistry.GetModelCapabilities(provider, model)
		if err == nil {
			return caps.ContextWindow, caps.MaxOutput
		}
	}
	return 0, 0
}
