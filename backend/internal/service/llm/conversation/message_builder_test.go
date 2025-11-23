package conversation

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"meridian/internal/capabilities"
	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/service/llm/formatting"
)

// TestBuildMessages_NormalConversation tests naive message building with a normal conversation
func TestBuildMessages_NormalConversation(t *testing.T) {
	// Create service
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	service := NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)

	// Create conversation path: user turn, assistant turn
	path := []llmModels.Turn{
		{
			ID:   "turn-1",
			Role: "user",
			Blocks: []llmModels.TurnBlock{
				{
					BlockType: llmModels.BlockTypeText,
					Content: map[string]interface{}{
						"text": "Hello, how are you?",
					},
				},
			},
		},
		{
			ID:   "turn-2",
			Role: "assistant",
			Blocks: []llmModels.TurnBlock{
				{
					BlockType: llmModels.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "User is greeting me",
					},
				},
				{
					BlockType: llmModels.BlockTypeText,
					Content: map[string]interface{}{
						"text": "I'm doing well, thank you!",
					},
				},
			},
		},
	}

	// Build messages
	messages, err := service.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Verify: 2 messages (one per turn)
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	// Verify first message (user)
	if messages[0].Role != "user" {
		t.Errorf("expected first message role to be 'user', got '%s'", messages[0].Role)
	}
	if len(messages[0].Content) != 1 {
		t.Errorf("expected first message to have 1 block, got %d", len(messages[0].Content))
	}

	// Verify second message (assistant)
	if messages[1].Role != "assistant" {
		t.Errorf("expected second message role to be 'assistant', got '%s'", messages[1].Role)
	}
	if len(messages[1].Content) != 2 {
		t.Errorf("expected second message to have 2 blocks, got %d", len(messages[1].Content))
	}
}

// TestBuildMessages_ToolContinuation tests naive message building with tool continuation
func TestBuildMessages_ToolContinuation(t *testing.T) {
	// Create service
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	service := NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)

	// Create assistant turn with tool_use + tool_result blocks from multiple rounds
	// This simulates what happens after tool continuation:
	// - Round 0: thinking, text, tool_use
	// - Round 1: tool_result (added by backend), thinking, tool_use
	// - Round 2: tool_result (added by backend)
	path := []llmModels.Turn{
		{
			ID:   "turn-1",
			Role: "assistant",
			Blocks: []llmModels.TurnBlock{
				{
					Sequence:  0,
					BlockType: llmModels.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "I need to search",
					},
				},
				{
					Sequence:  1,
					BlockType: llmModels.BlockTypeText,
					Content: map[string]interface{}{
						"text": "Let me search for that",
					},
				},
				{
					Sequence:  2,
					BlockType: llmModels.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "web_search",
						"input":       map[string]interface{}{"query": "test"},
					},
				},
				{
					Sequence:  3,
					BlockType: llmModels.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "web_search",
						"result":      "Search result 1",
					},
				},
				{
					Sequence:  4,
					BlockType: llmModels.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "Need another search",
					},
				},
				{
					Sequence:  5,
					BlockType: llmModels.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-2",
						"tool_name":   "web_search",
						"input":       map[string]interface{}{"query": "test2"},
					},
				},
				{
					Sequence:  6,
					BlockType: llmModels.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-2",
						"tool_name":   "web_search",
						"result":      "Search result 2",
					},
				},
			},
		},
	}

	// Build messages
	messages, err := service.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Verify: 1 message (naive approach - one per turn)
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	// Verify message has all 7 blocks (no splitting)
	if len(messages[0].Content) != 7 {
		t.Fatalf("expected message to have 7 blocks, got %d", len(messages[0].Content))
	}

	// Verify message role is assistant
	if messages[0].Role != "assistant" {
		t.Errorf("expected message role to be 'assistant', got '%s'", messages[0].Role)
	}

	// Verify block sequence (all blocks included in order)
	for i, block := range messages[0].Content {
		if block.Sequence != i {
			t.Errorf("expected block %d to have sequence %d, got %d", i, i, block.Sequence)
		}
	}

	// Verify block types are preserved
	expectedTypes := []string{
		llmModels.BlockTypeThinking,
		llmModels.BlockTypeText,
		llmModels.BlockTypeToolUse,
		llmModels.BlockTypeToolResult,
		llmModels.BlockTypeThinking,
		llmModels.BlockTypeToolUse,
		llmModels.BlockTypeToolResult,
	}

	for i, expected := range expectedTypes {
		if messages[0].Content[i].BlockType != expected {
			t.Errorf("expected block %d to be %s, got %s", i, expected, messages[0].Content[i].BlockType)
		}
	}
}

// TestBuildMessages_EmptyTurn tests that empty turns are skipped
func TestBuildMessages_EmptyTurn(t *testing.T) {
	// Create service
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	service := NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)

	// Create path with empty turn
	path := []llmModels.Turn{
		{
			ID:     "turn-1",
			Role:   "user",
			Blocks: []llmModels.TurnBlock{},
		},
		{
			ID:   "turn-2",
			Role: "assistant",
			Blocks: []llmModels.TurnBlock{
				{
					BlockType: llmModels.BlockTypeText,
					Content: map[string]interface{}{
						"text": "Hello",
					},
				},
			},
		},
	}

	// Build messages
	messages, err := service.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Verify: 1 message (empty turn skipped)
	if len(messages) != 1 {
		t.Fatalf("expected 1 message (empty turn skipped), got %d", len(messages))
	}

	// Verify message is from turn-2
	if messages[0].Role != "assistant" {
		t.Errorf("expected message role to be 'assistant', got '%s'", messages[0].Role)
	}
}

// TestBuildMessages_UnsupportedRole tests error handling for unsupported roles
func TestBuildMessages_UnsupportedRole(t *testing.T) {
	// Create service
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	service := NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)

	// Create path with unsupported role
	path := []llmModels.Turn{
		{
			ID:   "turn-1",
			Role: "system",
			Blocks: []llmModels.TurnBlock{
				{
					BlockType: llmModels.BlockTypeText,
					Content: map[string]interface{}{
						"text": "System message",
					},
				},
			},
		},
	}

	// Build messages
	_, err = service.BuildMessages(context.Background(), path)
	if err == nil {
		t.Fatal("expected error for unsupported role, got nil")
	}
}

// TestBuildMessages_ToolResultFormatting tests that tool_result blocks are formatted
func TestBuildMessages_ToolResultFormatting(t *testing.T) {
	// Create service with a formatter
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	service := NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)

	// Create path with tool_result block
	path := []llmModels.Turn{
		{
			ID:   "turn-1",
			Role: "assistant",
			Blocks: []llmModels.TurnBlock{
				{
					BlockType: llmModels.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "web_search",
						"result": map[string]interface{}{
							"status": "success",
							"data":   "result",
						},
					},
				},
			},
		},
	}

	// Build messages
	messages, err := service.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Verify: formatToolResultBlock was called (result should be formatted)
	// Note: Without a registered formatter, the result passes through unchanged
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	// Verify tool_result block is included
	if len(messages[0].Content) != 1 {
		t.Fatalf("expected 1 block, got %d", len(messages[0].Content))
	}

	if messages[0].Content[0].BlockType != llmModels.BlockTypeToolResult {
		t.Errorf("expected block type to be tool_result, got %s", messages[0].Content[0].BlockType)
	}
}
