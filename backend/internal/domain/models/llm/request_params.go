package llm

import (
	"encoding/json"
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
)

// RequestParams represents all possible LLM request parameters across providers.
// Client sends these as JSONB, provider adapters extract what they support.
// All fields are optional pointers to distinguish "not set" from "set to zero value".
type RequestParams struct {
	// ===== Core Parameters (Most Providers) =====

	// Model specifies the LLM model to use (e.g., "claude-haiku-4-5-20251001")
	// Can be overridden at request time
	Model *string `json:"model,omitempty"`

	// MaxTokens sets the maximum number of tokens to generate
	MaxTokens *int `json:"max_tokens,omitempty"`

	// Temperature controls randomness (0.0-1.0)
	// 0.0 = deterministic, 1.0 = maximum randomness
	Temperature *float64 `json:"temperature,omitempty"`

	// TopP (nucleus sampling) - cumulative probability cutoff (0.0-1.0)
	TopP *float64 `json:"top_p,omitempty"`

	// TopK limits sampling to top K tokens
	TopK *int `json:"top_k,omitempty"`

	// Stop sequences - generation stops if any of these are generated
	Stop []string `json:"stop,omitempty"`

	// Seed for deterministic sampling (if supported by provider)
	Seed *int `json:"seed,omitempty"`

	// ===== Anthropic-Specific Parameters =====

	// ThinkingEnabled enables extended thinking mode (Claude only)
	ThinkingEnabled *bool `json:"thinking_enabled,omitempty"`

	// ThinkingLevel sets the thinking budget: "low", "medium", "high"
	// Maps to token budgets: low=2000, medium=5000, high=12000
	ThinkingLevel *string `json:"thinking_level,omitempty"`

	// System prompt override (can also be set per turn)
	System *string `json:"system,omitempty"`

	// ===== OpenAI-Specific Parameters =====

	// FrequencyPenalty reduces repetition of token sequences (-2.0 to 2.0)
	FrequencyPenalty *float64 `json:"frequency_penalty,omitempty"`

	// PresencePenalty reduces repetition of topics (-2.0 to 2.0)
	PresencePenalty *float64 `json:"presence_penalty,omitempty"`

	// RepetitionPenalty reduces token repetition (some providers)
	RepetitionPenalty *float64 `json:"repetition_penalty,omitempty"`

	// MinP - minimum probability threshold for sampling
	MinP *float64 `json:"min_p,omitempty"`

	// TopA - top-a sampling parameter
	TopA *float64 `json:"top_a,omitempty"`

	// LogitBias adjusts likelihood of specific tokens
	LogitBias map[string]float64 `json:"logit_bias,omitempty"`

	// LogProbs returns log probabilities of output tokens
	LogProbs *bool `json:"logprobs,omitempty"`

	// TopLogProbs specifies how many top logprobs to return per token
	TopLogProbs *int `json:"top_logprobs,omitempty"`

	// ResponseFormat for structured outputs (JSON mode, etc.)
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`

	// ===== Tool Parameters =====

	// Tools available for the model to use (backend intermediate format)
	// Includes built-in tools (minimal: {"name": "web_search"})
	// and custom tools (full: {"type": "custom", "name": "...", "description": "...", "input_schema": {...}})
	// Converted to library types using ToLibraryTools() in conversion layer
	Tools []ToolDefinition `json:"tools,omitempty"`

	// ToolChoice controls whether/which tools to use
	// Use library ToolChoice type for type safety
	ToolChoice *llmprovider.ToolChoice `json:"tool_choice,omitempty"`

	// ParallelToolCalls allows model to use multiple tools simultaneously
	ParallelToolCalls *bool `json:"parallel_tool_calls,omitempty"`

	// ===== Provider Routing (OpenRouter) =====

	// Provider specifies which provider to use (OpenRouter)
	// Format: "anthropic/claude-haiku-4-5", "openai/gpt-4", etc.
	Provider *string `json:"provider,omitempty"`

	// FallbackModels lists alternative models if primary fails
	FallbackModels []string `json:"fallback_models,omitempty"`

	// ===== Debug Parameters (Only Active When DEBUG=true) =====

	// LoremMax limits lorem provider output to N words (DEBUG only)
	// Overrides max_tokens when using lorem-* models in DEBUG mode
	// Ignored in production (DEBUG=false)
	// Use case: Test streaming/interruption without waiting for large responses
	LoremMax *int `json:"lorem_max,omitempty"`
}

// ResponseFormat specifies the format for structured outputs
type ResponseFormat struct {
	Type       string      `json:"type"`                  // "text", "json_object", "json_schema"
	JSONSchema interface{} `json:"json_schema,omitempty"` // Schema for structured output
}

// LegacyTool represents a function the model can call (OpenAI format)
// DEPRECATED: Use llmprovider.Tool for new code
type LegacyTool struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

// ToolFunction defines a callable function (legacy OpenAI format)
type ToolFunction struct {
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	Parameters  interface{} `json:"parameters,omitempty"` // JSON schema for parameters
}

// ValidateRequestParams validates request parameters
func ValidateRequestParams(params map[string]interface{}) error {
	if params == nil {
		return nil // Empty params is valid
	}

	// Marshal and unmarshal to validate structure
	jsonBytes, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("invalid request params: %w", err)
	}

	var rp RequestParams
	if err := json.Unmarshal(jsonBytes, &rp); err != nil {
		return fmt.Errorf("invalid request params structure: %w", err)
	}

	// Validate ranges
	if rp.Temperature != nil {
		if *rp.Temperature < 0.0 || *rp.Temperature > 2.0 {
			return fmt.Errorf("temperature must be between 0.0 and 2.0, got %f", *rp.Temperature)
		}
	}

	if rp.TopP != nil {
		if *rp.TopP < 0.0 || *rp.TopP > 1.0 {
			return fmt.Errorf("top_p must be between 0.0 and 1.0, got %f", *rp.TopP)
		}
	}

	if rp.TopK != nil {
		if *rp.TopK < 0 {
			return fmt.Errorf("top_k must be non-negative, got %d", *rp.TopK)
		}
	}

	if rp.MaxTokens != nil {
		if *rp.MaxTokens < 1 {
			return fmt.Errorf("max_tokens must be positive, got %d", *rp.MaxTokens)
		}
	}

	if rp.ThinkingLevel != nil {
		validLevels := map[string]bool{"low": true, "medium": true, "high": true}
		if !validLevels[*rp.ThinkingLevel] {
			return fmt.Errorf("thinking_level must be 'low', 'medium', or 'high', got '%s'", *rp.ThinkingLevel)
		}
	}

	if rp.FrequencyPenalty != nil {
		if *rp.FrequencyPenalty < -2.0 || *rp.FrequencyPenalty > 2.0 {
			return fmt.Errorf("frequency_penalty must be between -2.0 and 2.0, got %f", *rp.FrequencyPenalty)
		}
	}

	if rp.PresencePenalty != nil {
		if *rp.PresencePenalty < -2.0 || *rp.PresencePenalty > 2.0 {
			return fmt.Errorf("presence_penalty must be between -2.0 and 2.0, got %f", *rp.PresencePenalty)
		}
	}

	if rp.LoremMax != nil {
		if *rp.LoremMax < 1 {
			return fmt.Errorf("lorem_max must be positive, got %d", *rp.LoremMax)
		}
	}

	return nil
}

// GetRequestParamStruct unmarshals a JSONB map into a typed RequestParams struct
func GetRequestParamStruct(params map[string]interface{}) (*RequestParams, error) {
	if params == nil {
		return &RequestParams{}, nil
	}

	jsonBytes, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal params: %w", err)
	}

	var rp RequestParams
	if err := json.Unmarshal(jsonBytes, &rp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal params: %w", err)
	}

	return &rp, nil
}

// GetMaxTokens returns max_tokens with default fallback
func (rp *RequestParams) GetMaxTokens(defaultValue int) int {
	if rp.MaxTokens != nil {
		return *rp.MaxTokens
	}
	return defaultValue
}

// GetTemperature returns temperature with default fallback
func (rp *RequestParams) GetTemperature(defaultValue float64) float64 {
	if rp.Temperature != nil {
		return *rp.Temperature
	}
	return defaultValue
}

// GetThinkingBudgetTokens converts thinking_level to token budget
// low = 2000, medium = 5000, high = 12000
func (rp *RequestParams) GetThinkingBudgetTokens() int {
	if rp.ThinkingLevel == nil {
		return 0 // Thinking not enabled
	}

	switch *rp.ThinkingLevel {
	case "low":
		return 2000
	case "medium":
		return 5000
	case "high":
		return 12000
	default:
		return 0
	}
}

// GetLoremMax returns lorem_max with default fallback
// Used to limit lorem provider output in DEBUG mode
func (rp *RequestParams) GetLoremMax(defaultValue int) int {
	if rp.LoremMax != nil {
		return *rp.LoremMax
	}
	return defaultValue
}
