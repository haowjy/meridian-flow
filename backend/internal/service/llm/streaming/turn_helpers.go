package streaming

// turn_helpers.go — Validation and utility functions shared by the turn pipeline
// and debug endpoints. Split out from turn_creation.go to keep the orchestrator
// focused on pipeline coordination.

import (
	"context"
	"fmt"
	"strings"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"

	"meridian/internal/config"
	domainllm "meridian/internal/domain/llm"
)

// CreateAssistantTurnDebug creates an assistant turn (DEBUG/INTERNAL USE ONLY)
//
// WARNING: This method is exposed for:
// 1. Debug handlers (ENVIRONMENT=dev only)
// 2. Internal LLM response generator (Phase 2)
//
// It bypasses the "user" role validation that the public CreateTurn endpoint enforces.
func (s *Service) CreateAssistantTurnDebug(
	ctx context.Context,
	threadID string,
	userID string,
	prevTurnID *string,
	contentBlocks []domainllm.TurnBlockInput,
	model string,
) (*domainllm.Turn, error) {
	// Validate thread exists and is not deleted
	if err := s.validator.ValidateThread(ctx, threadID, userID); err != nil {
		return nil, err
	}

	// Validate prev turn exists if provided
	if prevTurnID != nil {
		_, err := s.turnReader.GetTurn(ctx, *prevTurnID)
		if err != nil {
			return nil, err
		}
	}

	// Create assistant turn
	now := time.Now().UTC()
	turn := &domainllm.Turn{
		ThreadID:   threadID,
		PrevTurnID: prevTurnID,
		Role:       "assistant",
		Status:     domainllm.TurnStatusStreaming,
		Model:      &model,
		CreatedAt:  now,
	}

	if err := s.turnWriter.CreateTurn(ctx, turn); err != nil {
		return nil, err
	}

	// Create initial content blocks if provided
	if len(contentBlocks) > 0 {
		blocks := make([]domainllm.TurnBlock, len(contentBlocks))
		for i, blockInput := range contentBlocks {
			blocks[i] = domainllm.TurnBlock{
				TurnID:      turn.ID,
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content,
				CreatedAt:   now,
			}
		}

		if err := s.turnWriter.CreateTurnBlocks(ctx, blocks); err != nil {
			return nil, err
		}

		turn.Blocks = blocks
	}

	s.logger.Debug("assistant turn created (internal)",
		"id", turn.ID,
		"thread_id", threadID,
		"prev_turn_id", prevTurnID,
		"model", model,
		"turn_blocks", len(contentBlocks),
	)

	return turn, nil
}

// --- Validation helpers ---

func (s *Service) validateCreateTurnRequest(req *domainllm.CreateTurnRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.Role,
			validation.Required,
			validation.In("user"),
		),
		validation.Field(&req.TurnBlocks, validation.Each(validation.By(s.validateTurnBlock))),
	)
}

func (s *Service) validateTurnBlock(value interface{}) error {
	block, ok := value.(domainllm.TurnBlockInput)
	if !ok {
		return fmt.Errorf("invalid content block type")
	}

	if block.BlockType == "" {
		return fmt.Errorf("block_type is required")
	}

	validTypes := []string{
		"text", "thinking", "tool_use", "tool_result",
		"image", "reference", "partial_reference",
	}
	isValid := false
	for _, validType := range validTypes {
		if block.BlockType == validType {
			isValid = true
			break
		}
	}

	if !isValid {
		return fmt.Errorf("block_type must be one of: %v", validTypes)
	}

	if err := domainllm.ValidateContent(block.BlockType, block.Content); err != nil {
		return fmt.Errorf("invalid content for %s block: %w", block.BlockType, err)
	}

	return nil
}

// --- Utility functions ---

// extractToolNames extracts tool names from request params.
// Handles both minimal format {"name": "tool"} and full format {"function": {"name": "tool"}}.
func extractToolNames(requestParams map[string]interface{}) []string {
	toolNames := []string{}

	toolsRaw, ok := requestParams["tools"]
	if !ok {
		return toolNames
	}

	tools, ok := toolsRaw.([]interface{})
	if !ok {
		return toolNames
	}

	for _, toolRaw := range tools {
		toolMap, ok := toolRaw.(map[string]interface{})
		if !ok {
			continue
		}

		if name, ok := toolMap["name"].(string); ok {
			toolNames = append(toolNames, name)
			continue
		}

		if functionRaw, ok := toolMap["function"]; ok {
			if functionMap, ok := functionRaw.(map[string]interface{}); ok {
				if name, ok := functionMap["name"].(string); ok {
					toolNames = append(toolNames, name)
				}
			}
		}
	}

	return toolNames
}

// deriveTitleFromTurnBlocks extracts a title from the first text block content.
// Used for cold start thread creation where title is derived from user's first message.
const defaultTitleMaxWords = 6

func deriveTitleFromTurnBlocks(blocks []domainllm.TurnBlockInput) string {
	for _, block := range blocks {
		if block.BlockType == "text" && block.TextContent != nil {
			text := strings.TrimSpace(*block.TextContent)
			if text != "" {
				return truncateTitleFromText(text)
			}
		}
	}
	return "New Thread"
}

// truncateTitleFromText extracts first N words and truncates to max length.
func truncateTitleFromText(text string) string {
	words := strings.Fields(text)
	if len(words) > defaultTitleMaxWords {
		words = words[:defaultTitleMaxWords]
	}

	title := strings.Join(words, " ")

	if len(title) > config.MaxThreadTitleLength {
		title = title[:config.MaxThreadTitleLength-3] + "..."
	}

	return title
}
