package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"meridian/internal/domain/models/llm"
	llmrepo "meridian/internal/domain/repositories/llm"
)

// BlockAccumulator accumulates streaming deltas into complete TurnBlocks.
//
// Flow:
//   1. Receive TurnBlockDelta events from provider stream
//   2. Accumulate deltas for current block in memory
//   3. When block index changes, flush accumulated block to database
//   4. Return flushed block for SSE broadcast
//
// Thread-safety: NOT thread-safe. Should be used by a single goroutine (TurnExecutor).
type BlockAccumulator struct {
	turnID   string
	turnRepo llmrepo.TurnRepository

	// Current block being accumulated
	currentBlockIndex int
	currentBlockType  string
	accumulatedText   strings.Builder // Text content (for text, thinking blocks)
	accumulatedJSON   strings.Builder // JSON content (for tool_use input)

	// Block metadata
	toolUseID         *string // For tool_use blocks
	toolName          *string // For tool_use blocks
	thinkingSignature *string // For thinking blocks

	// Track last written block sequence for database writes
	lastWrittenSequence int
}

// NewBlockAccumulator creates a new BlockAccumulator for a turn.
func NewBlockAccumulator(turnID string, turnRepo llmrepo.TurnRepository) *BlockAccumulator {
	return &BlockAccumulator{
		turnID:              turnID,
		turnRepo:            turnRepo,
		currentBlockIndex:   -1, // No block started yet
		lastWrittenSequence: -1, // No blocks written yet
	}
}

// ProcessDelta processes a single TurnBlockDelta event.
// Returns the flushed TurnBlock if a block was completed, nil otherwise.
// Returns error if database write fails.
func (acc *BlockAccumulator) ProcessDelta(ctx context.Context, delta *llm.TurnBlockDelta) (*llm.TurnBlock, error) {
	// Check if this is a new block (index changed)
	if delta.BlockIndex != acc.currentBlockIndex {
		// Flush current block if one exists
		flushedBlock, err := acc.flushCurrentBlock(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to flush block %d: %w", acc.currentBlockIndex, err)
		}

		// Start new block
		acc.startNewBlock(delta)

		return flushedBlock, nil
	}

	// Same block - accumulate delta
	acc.accumulateDelta(delta)

	return nil, nil
}

// Finalize flushes any remaining accumulated block (called when streaming completes).
// Returns the final block if one exists, nil otherwise.
func (acc *BlockAccumulator) Finalize(ctx context.Context) (*llm.TurnBlock, error) {
	if acc.currentBlockIndex == -1 {
		return nil, nil // No block to flush
	}

	return acc.flushCurrentBlock(ctx)
}

// GetLastWrittenSequence returns the sequence number of the last block written to DB.
// Used for tracking progress and reconnection.
func (acc *BlockAccumulator) GetLastWrittenSequence() int {
	return acc.lastWrittenSequence
}

// startNewBlock initializes accumulator state for a new block.
func (acc *BlockAccumulator) startNewBlock(delta *llm.TurnBlockDelta) {
	acc.currentBlockIndex = delta.BlockIndex
	acc.currentBlockType = delta.BlockType

	// Reset accumulated content
	acc.accumulatedText.Reset()
	acc.accumulatedJSON.Reset()

	// Reset metadata
	acc.toolUseID = nil
	acc.toolName = nil
	acc.thinkingSignature = nil

	// Extract block start metadata
	if delta.ToolUseID != nil {
		acc.toolUseID = delta.ToolUseID
	}
	if delta.ToolName != nil {
		acc.toolName = delta.ToolName
	}
	if delta.ThinkingSignature != nil {
		acc.thinkingSignature = delta.ThinkingSignature
	}

	// Accumulate initial delta (if present)
	acc.accumulateDelta(delta)
}

// accumulateDelta adds delta content to current block.
func (acc *BlockAccumulator) accumulateDelta(delta *llm.TurnBlockDelta) {
	if delta.TextDelta != nil {
		acc.accumulatedText.WriteString(*delta.TextDelta)
	}

	if delta.InputJSONDelta != nil {
		acc.accumulatedJSON.WriteString(*delta.InputJSONDelta)
	}

	// Update metadata if provided (edge case: metadata comes in separate delta)
	if delta.ToolUseID != nil {
		acc.toolUseID = delta.ToolUseID
	}
	if delta.ToolName != nil {
		acc.toolName = delta.ToolName
	}
	if delta.ThinkingSignature != nil {
		acc.thinkingSignature = delta.ThinkingSignature
	}
}

// flushCurrentBlock writes the accumulated block to the database.
// Returns the written block or nil if no block to flush.
func (acc *BlockAccumulator) flushCurrentBlock(ctx context.Context) (*llm.TurnBlock, error) {
	if acc.currentBlockIndex == -1 {
		return nil, nil // No block to flush
	}

	// Build TurnBlock from accumulated state
	block := &llm.TurnBlock{
		TurnID:    acc.turnID,
		BlockType: acc.currentBlockType,
		Sequence:  acc.currentBlockIndex,
	}

	// Set text content (for text, thinking, tool_result blocks)
	text := acc.accumulatedText.String()
	if text != "" {
		block.TextContent = &text
	}

	// Set JSONB content (type-specific metadata)
	content := make(map[string]interface{})

	switch acc.currentBlockType {
	case llm.BlockTypeText:
		// Text block: no JSONB content needed (text in text_content)
		block.Content = nil

	case llm.BlockTypeThinking:
		// Thinking block: add signature if present
		if acc.thinkingSignature != nil {
			content["signature"] = *acc.thinkingSignature
		}
		if len(content) > 0 {
			block.Content = content
		}

	case llm.BlockTypeToolUse:
		// Tool use block: parse accumulated JSON input
		if acc.toolUseID != nil {
			content["tool_use_id"] = *acc.toolUseID
		}
		if acc.toolName != nil {
			content["tool_name"] = *acc.toolName
		}

		// Parse accumulated JSON input
		jsonStr := acc.accumulatedJSON.String()
		if jsonStr != "" {
			var inputData map[string]interface{}
			if err := json.Unmarshal([]byte(jsonStr), &inputData); err != nil {
				return nil, fmt.Errorf("failed to parse tool input JSON: %w", err)
			}
			content["input"] = inputData
		}

		block.Content = content

	default:
		// Unknown block type - store as-is
		block.Content = nil
	}

	// Write block to database
	if err := acc.turnRepo.CreateTurnBlock(ctx, block); err != nil {
		return nil, fmt.Errorf("failed to create turn block in database: %w", err)
	}

	// Update last written sequence
	acc.lastWrittenSequence = acc.currentBlockIndex

	// Return the block for SSE broadcast
	return block, nil
}

// GetCurrentBlock returns the current block being accumulated (for catchup events).
// Does NOT flush to database. Returns nil if no block is being accumulated.
func (acc *BlockAccumulator) GetCurrentBlock() *llm.TurnBlock {
	if acc.currentBlockIndex == -1 {
		return nil // No block started
	}

	// Build partial block from current state (same logic as flushCurrentBlock)
	block := &llm.TurnBlock{
		TurnID:    acc.turnID,
		BlockType: acc.currentBlockType,
		Sequence:  acc.currentBlockIndex,
	}

	// Set text content
	text := acc.accumulatedText.String()
	if text != "" {
		block.TextContent = &text
	}

	// Set JSONB content
	content := make(map[string]interface{})

	switch acc.currentBlockType {
	case llm.BlockTypeThinking:
		if acc.thinkingSignature != nil {
			content["signature"] = *acc.thinkingSignature
		}
		if len(content) > 0 {
			block.Content = content
		}

	case llm.BlockTypeToolUse:
		if acc.toolUseID != nil {
			content["tool_use_id"] = *acc.toolUseID
		}
		if acc.toolName != nil {
			content["tool_name"] = *acc.toolName
		}

		// Include partial JSON if any (may not be valid JSON yet)
		jsonStr := acc.accumulatedJSON.String()
		if jsonStr != "" {
			content["input_partial"] = jsonStr // Mark as partial
		}

		if len(content) > 0 {
			block.Content = content
		}
	}

	return block
}
