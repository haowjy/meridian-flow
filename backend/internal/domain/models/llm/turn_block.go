package llm

import (
	"encoding/json"
	"time"
)

// Block type constants
const (
	BlockTypeText             = "text"
	BlockTypeThinking         = "thinking"
	BlockTypeToolUse          = "tool_use"
	BlockTypeToolResult       = "tool_result"
	BlockTypeImage            = "image"
	BlockTypeReference        = "reference"
	BlockTypePartialReference = "partial_reference"
	BlockTypeWebSearch        = "web_search_use"    // Server-executed web search invocation (LLM request)
	BlockTypeWebSearchResult  = "web_search_result" // Server-executed web search result (provider response)
)

// TurnBlock represents a multimodal content block in a turn (user or assistant)
// Accumulated from Anthropic's streaming content_block deltas during LLM execution
//
// User blocks: text, image, reference, partial_reference, tool_result
// Assistant blocks: text, thinking, tool_use, web_search, web_search_result
//
// The content field stores block-type-specific structured data as JSONB:
// - text: null (text in text_content field)
// - thinking: null (text in text_content, signature in provider_data)
// - tool_use: {"tool_use_id": "toolu_...", "tool_name": "...", "input": {...}}
// - tool_result: {"tool_use_id": "toolu_...", "is_error": false}
// - web_search: {"tool_use_id": "toolu_...", "tool_name": "web_search", "input": {...}}
// - web_search_result: {"tool_use_id": "toolu_...", "results": [{title, url, page_age}]} or {"tool_use_id": "...", "is_error": true, "error_code": "..."}
// - image: {"url": "...", "mime_type": "...", "alt_text": "..."}
// - reference: {"ref_id": "...", "ref_type": "...", "selection_start": 0, ...}
type TurnBlock struct {
	ID            string                 `json:"id" db:"id"`
	TurnID        string                 `json:"turn_id" db:"turn_id"`
	BlockType     string                 `json:"block_type" db:"block_type"`
	Sequence      int                    `json:"sequence" db:"sequence"`
	TextContent   *string                `json:"text_content,omitempty" db:"text_content"`
	Content       map[string]interface{} `json:"content,omitempty" db:"content"`    // JSONB for type-specific data
	Provider      *string                `json:"provider,omitempty" db:"provider"`
	ProviderData  json.RawMessage        `json:"provider_data,omitempty" db:"provider_data"` // JSONB for raw provider-specific data (opaque bytes)
	ExecutionSide *string                `json:"execution_side,omitempty" db:"execution_side"`        // "server" or "client" for tool_use blocks
	CreatedAt     time.Time              `json:"created_at" db:"created_at"`
}

// IsUserBlock returns true if this is a user turn block
func (tb *TurnBlock) IsUserBlock() bool {
	return tb.BlockType == BlockTypeText ||
		tb.BlockType == BlockTypeImage ||
		tb.BlockType == BlockTypeReference ||
		tb.BlockType == BlockTypePartialReference ||
		tb.BlockType == BlockTypeToolResult
}

// IsAssistantBlock returns true if this is an assistant turn block
func (tb *TurnBlock) IsAssistantBlock() bool {
	return tb.BlockType == BlockTypeText ||
		tb.BlockType == BlockTypeThinking ||
		tb.BlockType == BlockTypeToolUse ||
		tb.BlockType == BlockTypeWebSearch ||
		tb.BlockType == BlockTypeWebSearchResult
}

// IsToolBlock returns true if this is a tool-related block (tool_use, tool_result, web_search, web_search_result)
func (tb *TurnBlock) IsToolBlock() bool {
	return tb.BlockType == BlockTypeToolUse ||
		tb.BlockType == BlockTypeToolResult ||
		tb.BlockType == BlockTypeWebSearch ||
		tb.BlockType == BlockTypeWebSearchResult
}

// IsServerSideTool returns true if this is a server-side tool_use block (e.g., web_search)
func (tb *TurnBlock) IsServerSideTool() bool {
	return tb.BlockType == BlockTypeToolUse && tb.ExecutionSide != nil && *tb.ExecutionSide == "server"
}

// IsClientSideTool returns true if this is a client-side tool_use block (e.g., bash, text_editor)
// Treats nil ExecutionSide as client-side (defensive default)
func (tb *TurnBlock) IsClientSideTool() bool {
	return tb.BlockType == BlockTypeToolUse && (tb.ExecutionSide == nil || *tb.ExecutionSide == "client")
}
