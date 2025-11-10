package llm

import (
	"time"
)

// Block type constants
const (
	BlockTypeText            = "text"
	BlockTypeThinking        = "thinking"
	BlockTypeToolUse         = "tool_use"
	BlockTypeToolResult      = "tool_result"
	BlockTypeImage           = "image"
	BlockTypeReference       = "reference"
	BlockTypePartialReference = "partial_reference"
)

// TurnBlock represents a multimodal content block in a turn (user or assistant)
// Accumulated from Anthropic's streaming content_block deltas during LLM execution
//
// User blocks: text, image, reference, partial_reference, tool_result
// Assistant blocks: text, thinking, tool_use
//
// The content field stores block-type-specific structured data as JSONB:
// - text: null (text in text_content field)
// - thinking: {"signature": "4k_a"} (optional, text in text_content)
// - tool_use: {"tool_use_id": "toolu_...", "tool_name": "...", "input": {...}}
// - tool_result: {"tool_use_id": "toolu_...", "is_error": false}
// - image: {"url": "...", "mime_type": "...", "alt_text": "..."}
// - reference: {"ref_id": "...", "ref_type": "...", "selection_start": 0, ...}
type TurnBlock struct {
	ID          string                 `json:"id" db:"id"`
	TurnID      string                 `json:"turn_id" db:"turn_id"`
	BlockType   string                 `json:"block_type" db:"block_type"`
	Sequence    int                    `json:"sequence" db:"sequence"`
	TextContent *string                `json:"text_content,omitempty" db:"text_content"`
	Content     map[string]interface{} `json:"content,omitempty" db:"content"` // JSONB for type-specific data
	CreatedAt   time.Time              `json:"created_at" db:"created_at"`
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
		tb.BlockType == BlockTypeToolUse
}

// IsToolBlock returns true if this is a tool-related block (tool_use or tool_result)
func (tb *TurnBlock) IsToolBlock() bool {
	return tb.BlockType == BlockTypeToolUse || tb.BlockType == BlockTypeToolResult
}
