package llm

import (
	"encoding/json"
	"time"
)

// GenerationRecord represents a single OpenRouter generation request within an assistant turn.
// Multiple generation records can exist for a single turn when tool continuations occur.
// Stored in turns.response_metadata.openrouter.generations[] as a JSONB array.
type GenerationRecord struct {
	// ID is the OpenRouter generation ID (e.g., "gen-abc123xyz")
	ID string `json:"id"`

	// RequestIndex indicates the order of this request within the turn (0=initial, 1+=continuation)
	RequestIndex int `json:"request_index"`

	// Phase indicates whether this was the initial request or a tool continuation
	// Values: "initial" | "tool_continue"
	Phase string `json:"phase"`

	// Model is the model that was requested (e.g., "x-ai/grok-beta")
	Model string `json:"model,omitempty"`

	// ProviderName is the upstream provider that actually served the request
	// (e.g., "DeepInfra", "OpenAI", "Together")
	// Obtained from OpenRouter's /generation API
	ProviderName string `json:"provider_name,omitempty"`

	// NativeTokensPrompt is the number of input tokens according to the model's native tokenizer
	NativeTokensPrompt int `json:"native_tokens_prompt,omitempty"`

	// NativeTokensCompletion is the number of output tokens according to the model's native tokenizer
	NativeTokensCompletion int `json:"native_tokens_completion,omitempty"`

	// NativeTokensReasoning is the number of reasoning tokens (o1, DeepSeek-R1, MiniMax)
	// These are separate from completion tokens and essential for accurate cost tracking
	NativeTokensReasoning int `json:"native_tokens_reasoning,omitempty"`

	// NativeTokensCached is the number of cached tokens (cache hits)
	NativeTokensCached int `json:"native_tokens_cached,omitempty"`

	// TotalCost is the cost of this generation in USD
	TotalCost float64 `json:"total_cost,omitempty"`

	// FinishReason indicates why generation stopped
	// (e.g., "stop", "length", "tool_use", "content_filter")
	FinishReason string `json:"finish_reason,omitempty"`

	// CreatedAt is the timestamp when the generation was created
	CreatedAt time.Time `json:"created_at,omitempty"`

	// UpstreamID is the provider's request ID (e.g., OpenAI's request ID)
	UpstreamID string `json:"upstream_id,omitempty"`

	// Latency is the request latency in milliseconds
	Latency int64 `json:"latency,omitempty"`

	// Cancelled indicates whether this generation was cancelled via OpenRouter's API
	// Note: This reflects server-side cancellation status, not client-side soft cancel
	Cancelled bool `json:"cancelled,omitempty"`

	// Enrichment tracking fields (for cancel-via-generation plan compatibility)

	// Finalized indicates whether this record has been enriched with full API data
	// true = complete data from /generation API
	// false = partial record (ID only, waiting for background enrichment)
	Finalized bool `json:"finalized"`

	// FinalizeAttempts tracks how many times enrichment was attempted (for retry logic)
	FinalizeAttempts int `json:"finalize_attempts,omitempty"`

	// FinalizeLastError stores the last error message from enrichment attempts
	FinalizeLastError string `json:"finalize_last_error,omitempty"`

	// AdditionalFields preserves unknown JSON fields from OpenRouter API
	// This provides forward compatibility when OpenRouter adds new fields
	AdditionalFields map[string]interface{} `json:"-"`
}

// UnmarshalJSON custom implementation to preserve unknown JSON fields
func (gr *GenerationRecord) UnmarshalJSON(data []byte) error {
	// Create alias to avoid recursion
	type Alias GenerationRecord
	aux := &struct {
		*Alias
	}{
		Alias: (*Alias)(gr),
	}

	// Unmarshal into known fields
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	// Unmarshal into map to capture all fields
	var allFields map[string]interface{}
	if err := json.Unmarshal(data, &allFields); err != nil {
		return err
	}

	// Remove known fields from map
	knownFields := []string{
		"id", "request_index", "phase", "model", "provider_name",
		"native_tokens_prompt", "native_tokens_completion",
		"native_tokens_reasoning", "native_tokens_cached",
		"total_cost", "finish_reason", "created_at",
		"upstream_id", "latency", "cancelled",
		"finalized", "finalize_attempts", "finalize_last_error",
	}

	for _, field := range knownFields {
		delete(allFields, field)
	}

	// Store remaining unknown fields
	if len(allFields) > 0 {
		gr.AdditionalFields = allFields
	}

	return nil
}

// MarshalJSON custom implementation to merge known + unknown fields
func (gr *GenerationRecord) MarshalJSON() ([]byte, error) {
	// Create alias to avoid recursion
	type Alias GenerationRecord
	aux := (*Alias)(gr)

	// Marshal known fields
	knownBytes, err := json.Marshal(aux)
	if err != nil {
		return nil, err
	}

	// If no additional fields, return known fields only
	if len(gr.AdditionalFields) == 0 {
		return knownBytes, nil
	}

	// Merge known + additional fields
	var knownMap map[string]interface{}
	if err := json.Unmarshal(knownBytes, &knownMap); err != nil {
		return nil, err
	}

	for k, v := range gr.AdditionalFields {
		knownMap[k] = v
	}

	return json.Marshal(knownMap)
}

// OpenRouterMetadata represents the OpenRouter-specific section of response_metadata.
// Structure: turns.response_metadata.openrouter = { generations: [...] }
type OpenRouterMetadata struct {
	// Generations is the array of per-request generation records
	Generations []GenerationRecord `json:"generations"`
}
