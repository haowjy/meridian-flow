package llm

// Delta type constants for streaming events
const (
	DeltaTypeTextDelta      = "text_delta"       // Text content delta
	DeltaTypeInputJSONDelta = "input_json_delta" // Tool input JSON delta
)

// TurnBlockDelta represents an incremental update to a turn block during streaming
// This is an ephemeral model - deltas are accumulated into TurnBlocks in memory,
// and only complete TurnBlocks are persisted to the database.
//
// Delta flow:
//   1. Provider streams deltas (e.g., Anthropic content_block_delta events)
//   2. Deltas transformed to TurnBlockDelta
//   3. BlockAccumulator accumulates deltas in memory
//   4. On block type change, accumulated content written as TurnBlock to DB
//   5. TurnBlockDelta events broadcast to SSE clients for real-time UI updates
type TurnBlockDelta struct {
	// BlockIndex identifies which block this delta belongs to (0-indexed)
	// Matches the Sequence field in TurnBlock
	BlockIndex int `json:"block_index"`

	// BlockType indicates the type of block being accumulated
	// Values: "text", "thinking", "tool_use"
	BlockType string `json:"block_type"`

	// DeltaType indicates what kind of delta this is
	// Values: "text_delta", "input_json_delta"
	DeltaType string `json:"delta_type"`

	// TextDelta contains the incremental text content (for text/thinking blocks)
	// Accumulated into TurnBlock.TextContent
	TextDelta *string `json:"text_delta,omitempty"`

	// InputJSONDelta contains incremental JSON for tool input (for tool_use blocks)
	// Accumulated into TurnBlock.Content["input"]
	InputJSONDelta *string `json:"input_json_delta,omitempty"`

	// ToolUseID is set when a tool_use block starts
	// Stored in TurnBlock.Content["tool_use_id"]
	ToolUseID *string `json:"tool_use_id,omitempty"`

	// ToolName is set when a tool_use block starts
	// Stored in TurnBlock.Content["tool_name"]
	ToolName *string `json:"tool_name,omitempty"`

	// ThinkingSignature is set when a thinking block starts (e.g., "4k_a")
	// Stored in TurnBlock.Content["signature"]
	ThinkingSignature *string `json:"thinking_signature,omitempty"`
}

// IsTextDelta returns true if this delta contains text content
func (d *TurnBlockDelta) IsTextDelta() bool {
	return d.DeltaType == DeltaTypeTextDelta && d.TextDelta != nil
}

// IsInputJSONDelta returns true if this delta contains tool input JSON
func (d *TurnBlockDelta) IsInputJSONDelta() bool {
	return d.DeltaType == DeltaTypeInputJSONDelta && d.InputJSONDelta != nil
}

// IsBlockStart returns true if this delta signals the start of a new block
// Detected by presence of block-specific initialization fields
func (d *TurnBlockDelta) IsBlockStart() bool {
	return d.ToolUseID != nil || d.ToolName != nil || d.ThinkingSignature != nil
}
