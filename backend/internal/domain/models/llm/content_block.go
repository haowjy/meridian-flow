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

// ContentBlock represents a multimodal content block in a turn (user or assistant)
// Supports text, thinking, tool use, images, and document references
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
type ContentBlock struct {
	ID          string                 `json:"id" db:"id"`
	TurnID      string                 `json:"turn_id" db:"turn_id"`
	BlockType   string                 `json:"block_type" db:"block_type"`
	Sequence    int                    `json:"sequence" db:"sequence"`
	TextContent *string                `json:"text_content,omitempty" db:"text_content"`
	Content     map[string]interface{} `json:"content,omitempty" db:"content"` // JSONB for type-specific data
	CreatedAt   time.Time              `json:"created_at" db:"created_at"`
}

// IsUserBlock returns true if this is a user content block
func (cb *ContentBlock) IsUserBlock() bool {
	return cb.BlockType == BlockTypeText ||
		cb.BlockType == BlockTypeImage ||
		cb.BlockType == BlockTypeReference ||
		cb.BlockType == BlockTypePartialReference ||
		cb.BlockType == BlockTypeToolResult
}

// IsAssistantBlock returns true if this is an assistant content block
func (cb *ContentBlock) IsAssistantBlock() bool {
	return cb.BlockType == BlockTypeText ||
		cb.BlockType == BlockTypeThinking ||
		cb.BlockType == BlockTypeToolUse
}

// IsToolBlock returns true if this is a tool-related block (tool_use or tool_result)
func (cb *ContentBlock) IsToolBlock() bool {
	return cb.BlockType == BlockTypeToolUse || cb.BlockType == BlockTypeToolResult
}
