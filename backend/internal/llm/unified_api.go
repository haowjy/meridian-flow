package llm

// This file defines the unified interface for interacting with LLM providers.
// The structure is based on the OpenAI Chat Completions API specification, which is
// also supported by OpenRouter as a unified endpoint for various models.

// UnifiedRequest represents the request payload sent to an LLM provider.
type UnifiedRequest struct {
	Model        string        `json:"model"`
	Messages     []Message     `json:"messages"`
	System       string        `json:"system,omitempty"` // For providers like Anthropic
	Tools        []Tool        `json:"tools,omitempty"`
	ToolChoice   interface{}   `json:"tool_choice,omitempty"` // string or ToolChoice object
	Stream       bool          `json:"stream,omitempty"`
	MaxTokens    int           `json:"max_tokens,omitempty"`
	Temperature  float32       `json:"temperature,omitempty"`
	TopP         float32       `json:"top_p,omitempty"`
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`
}

// Message represents a single message in the conversation history.
type Message struct {
	Role       string      `json:"role"`
	Content    interface{} `json:"content"` // string or []ContentPart
	ToolCalls  []ToolCall  `json:"tool_calls,omitempty"`
	ToolCallID string      `json:"tool_call_id,omitempty"`
}

// ContentPart is used for multi-modal inputs, combining different types of content.
type ContentPart struct {
	Type     string    `json:"type"` // "text" or "image_url"
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

// ImageURL specifies the URL or base64-encoded data of an image.
type ImageURL struct {
	URL    string `json:"url"`
	Detail string `json:"detail,omitempty"` // "low", "high", or "auto"
}

// Tool represents a tool the model can call.
type Tool struct {
	Type     string   `json:"type"` // "function"
	Function Function `json:"function"`
}

// Function describes a function the model can call.
type Function struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Parameters  any    `json:"parameters"` // JSON Schema object
}

// ToolChoice specifies how the model should use tools.
type ToolChoice struct {
	Type     string            `json:"type"` // "function"
	Function ToolChoiceFunction `json:"function"`
}

type ToolChoiceFunction struct {
	Name string `json:"name"`
}

// ResponseFormat forces the model to output a specific format, like JSON.
type ResponseFormat struct {
	Type string `json:"type"` // "json_object"
}

// --- Unified Response Structures ---

// UnifiedResponse represents a non-streaming response from an LLM provider.
type UnifiedResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

// Choice represents a single completion choice.
type Choice struct {
	Index        int     `json:"index"`
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"`
}

// ToolCall represents a tool call requested by the model.
type ToolCall struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"` // "function"
	Function ToolCallFunction `json:"function"`
}

// ToolCallFunction specifies the function name and arguments for a tool call.
type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // JSON string
}

// Usage provides token usage statistics for the request.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// --- Unified Streaming Structures ---

// UnifiedStreamChunk represents a single chunk in a streaming response.
type UnifiedStreamChunk struct {
	ID      string        `json:"id"`
	Object  string        `json:"object"`
	Created int64         `json:"created"`
	Model   string        `json:"model"`
	Choices []StreamChoice `json:"choices"`
}

// StreamChoice represents a single choice in a streaming chunk.
type StreamChoice struct {
	Index        int         `json:"index"`
	Delta        StreamDelta `json:"delta"`
	FinishReason string      `json:"finish_reason"`
}

// StreamDelta contains the incremental update (a token or a tool call part).
type StreamDelta struct {
	Role      string     `json:"role,omitempty"`
	Content   string     `json:"content,omitempty"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
}
