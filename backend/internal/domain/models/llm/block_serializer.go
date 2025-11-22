package llm

import (
	"encoding/json"

	mstream "github.com/haowjy/meridian-stream-go"
)

// BlockSerializer converts TurnBlocks to SSE events for streaming/catchup
type BlockSerializer struct{}

// NewBlockSerializer creates a new BlockSerializer instance
func NewBlockSerializer() *BlockSerializer {
	return &BlockSerializer{}
}

// BlockToSSEEvents converts a TurnBlock into a sequence of SSE events
// Returns: block_start, block_delta (if content exists), block_stop
//
// This centralizes the logic for converting persisted blocks to streaming events,
// used for:
// - Catchup (replaying missed events during reconnection)
// - Future features (exporting conversations, testing)
func (s *BlockSerializer) BlockToSSEEvents(block *TurnBlock, blockIndex int) []mstream.Event {
	var events []mstream.Event

	// 1. block_start event
	blockStartData, _ := json.Marshal(BlockStartEvent{
		BlockIndex: blockIndex,
		BlockType:  &block.BlockType,
	})
	events = append(events, mstream.NewEvent(blockStartData).
		WithType(SSEEventBlockStart))

	// 2. block_delta event(s) - send full content as single delta
	//    (During catchup, we send the complete content at once)

	// Text content (for text, thinking blocks)
	if block.TextContent != nil && *block.TextContent != "" {
		blockDeltaData, _ := json.Marshal(BlockDeltaEvent{
			BlockIndex: blockIndex,
			DeltaType:  "text_delta",
			TextDelta:  block.TextContent,
			JSONDelta:  nil,
		})
		events = append(events, mstream.NewEvent(blockDeltaData).
			WithType(SSEEventBlockDelta))
	}

	// Structured content (for tool_use, tool_result blocks)
	if block.Content != nil {
		contentJSON, _ := json.Marshal(block.Content)
		contentStr := string(contentJSON)
		blockDeltaData, _ := json.Marshal(BlockDeltaEvent{
			BlockIndex: blockIndex,
			DeltaType:  "json_delta",
			TextDelta:  nil,
			JSONDelta:  &contentStr,
		})
		events = append(events, mstream.NewEvent(blockDeltaData).
			WithType(SSEEventBlockDelta))
	}

	// 3. block_stop event
	blockStopData, _ := json.Marshal(BlockStopEvent{
		BlockIndex: blockIndex,
	})
	events = append(events, mstream.NewEvent(blockStopData).
		WithType(SSEEventBlockStop))

	return events
}
