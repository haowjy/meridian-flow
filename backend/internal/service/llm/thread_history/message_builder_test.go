package threadhistory

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"

	"meridian/internal/capabilities"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/formatting"
)

// TestBuildMessages_NormalThread tests naive message building with a normal thread
func TestBuildMessages_NormalThread(t *testing.T) {
	service := newTestService(t)

	// Create conversation path: user turn, assistant turn
	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeText,
					Content: map[string]interface{}{
						"text": "Hello, how are you?",
					},
				},
			},
		},
		{
			ID:   "turn-2",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "User is greeting me",
					},
				},
				{
					BlockType: domainllm.BlockTypeText,
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
	service := newTestService(t)

	// Create assistant turn with tool_use + tool_result blocks from multiple rounds
	// This simulates what happens after tool continuation:
	// - Round 0: thinking, text, tool_use
	// - Round 1: tool_result (added by backend), thinking, tool_use
	// - Round 2: tool_result (added by backend)
	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					Sequence:  0,
					BlockType: domainllm.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "I need to search",
					},
				},
				{
					Sequence:  1,
					BlockType: domainllm.BlockTypeText,
					Content: map[string]interface{}{
						"text": "Let me search for that",
					},
				},
				{
					Sequence:  2,
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "web_search",
						"input":       map[string]interface{}{"query": "test"},
					},
				},
				{
					Sequence:  3,
					BlockType: domainllm.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "web_search",
						"result":      "Search result 1",
					},
				},
				{
					Sequence:  4,
					BlockType: domainllm.BlockTypeThinking,
					Content: map[string]interface{}{
						"thinking": "Need another search",
					},
				},
				{
					Sequence:  5,
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-2",
						"tool_name":   "web_search",
						"input":       map[string]interface{}{"query": "test2"},
					},
				},
				{
					Sequence:  6,
					BlockType: domainllm.BlockTypeToolResult,
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
		domainllm.BlockTypeThinking,
		domainllm.BlockTypeText,
		domainllm.BlockTypeToolUse,
		domainllm.BlockTypeToolResult,
		domainllm.BlockTypeThinking,
		domainllm.BlockTypeToolUse,
		domainllm.BlockTypeToolResult,
	}

	for i, expected := range expectedTypes {
		if messages[0].Content[i].BlockType != expected {
			t.Errorf("expected block %d to be %s, got %s", i, expected, messages[0].Content[i].BlockType)
		}
	}
}

func TestBuildMessages_FormatsStructuredToolErrors(t *testing.T) {
	service := newTestService(t)

	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					Sequence:  0,
					BlockType: domainllm.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "str_replace_based_edit_tool",
						"result": map[string]interface{}{
							"success":    false,
							"error_code": "MISSING_PARAM",
							"message":    "Missing required parameter",
							"error_data": map[string]any{"param": "path"},
						},
					},
				},
			},
		},
	}

	messages, err := service.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
	if len(messages[0].Content) != 1 {
		t.Fatalf("expected 1 block, got %d", len(messages[0].Content))
	}

	result, ok := messages[0].Content[0].Content["result"]
	if !ok {
		t.Fatalf("expected tool_result to contain result")
	}
	if result != "MISSING_PARAM:path" {
		t.Fatalf("result=%v, want %v", result, "MISSING_PARAM:path")
	}
}

// TestBuildMessages_EmptyTurn tests that empty turns are skipped
func TestBuildMessages_EmptyTurn(t *testing.T) {
	service := newTestService(t)

	// Create path with empty turn
	path := []domainllm.Turn{
		{
			ID:     "turn-1",
			Role:   "user",
			Blocks: []domainllm.TurnBlock{},
		},
		{
			ID:   "turn-2",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeText,
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
	service := newTestService(t)

	// Create path with unsupported role
	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "system",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeText,
					Content: map[string]interface{}{
						"text": "System message",
					},
				},
			},
		},
	}

	// Build messages
	_, err := service.BuildMessages(context.Background(), path)
	if err == nil {
		t.Fatal("expected error for unsupported role, got nil")
	}
}

// TestBuildMessages_ToolResultFormatting tests that tool_result blocks are formatted
func TestBuildMessages_ToolResultFormatting(t *testing.T) {
	service := newTestService(t)

	// Create path with tool_result block
	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolResult,
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

	if messages[0].Content[0].BlockType != domainllm.BlockTypeToolResult {
		t.Errorf("expected block type to be tool_result, got %s", messages[0].Content[0].BlockType)
	}
}

// =============================================================================
// Bookmark-aware tests (CM3)
// =============================================================================

func newTestService(t *testing.T) *MessageBuilderService {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	formatterRegistry := formatting.NewFormatterRegistry()
	capabilityRegistry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("Failed to create capability registry: %v", err)
	}
	return NewMessageBuilderService(formatterRegistry, capabilityRegistry, logger)
}

func ptrStr(s string) *string { return &s }

func compactionTurn(id, summary string) domainllm.Turn {
	return domainllm.Turn{
		ID:   id,
		Role: domainllm.TurnRoleSystem,
		RequestParams: map[string]interface{}{
			"turn_type": domainllm.TurnTypeCompaction,
		},
		Blocks: []domainllm.TurnBlock{
			{
				BlockType:   domainllm.BlockTypeText,
				Sequence:    0,
				TextContent: ptrStr(summary),
			},
		},
	}
}

func collapseMarkerTurn(id string) domainllm.Turn {
	return domainllm.Turn{
		ID:   id,
		Role: domainllm.TurnRoleSystem,
		RequestParams: map[string]interface{}{
			"turn_type": domainllm.TurnTypeCollapseMarker,
		},
		Blocks: []domainllm.TurnBlock{},
	}
}

// TestBuildMessages_NoBookmarks_RegressionGate verifies that a path with no bookmark
// turns produces output identical to the pre-bookmark behaviour.
// This is the critical regression gate for CM3.
func TestBuildMessages_NoBookmarks_RegressionGate(t *testing.T) {
	svc := newTestService(t)

	path := []domainllm.Turn{
		{
			ID:   "turn-1",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Hello")},
			},
		},
		{
			ID:   "turn-2",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Hi there")},
			},
		},
	}

	messages, err := svc.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Expect exactly 2 messages — no extras injected.
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}
	if messages[0].Role != "user" {
		t.Errorf("expected first message role=user, got %q", messages[0].Role)
	}
	if messages[1].Role != "assistant" {
		t.Errorf("expected second message role=assistant, got %q", messages[1].Role)
	}
}

// TestBuildMessages_CompactionTurn_SkipsPriorTurns verifies that turns before the
// compaction bookmark are skipped and the summary is injected as a leading user message.
func TestBuildMessages_CompactionTurn_SkipsPriorTurns(t *testing.T) {
	svc := newTestService(t)

	const summary = "Previously: user asked about goroutines; assistant explained them."

	path := []domainllm.Turn{
		// These turns should be SKIPPED (before compaction).
		{
			ID:   "turn-old-user",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("What are goroutines?")},
			},
		},
		{
			ID:   "turn-old-asst",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Goroutines are lightweight threads.")},
			},
		},
		// Compaction bookmark.
		compactionTurn("compaction-1", summary),
		// These turns should be INCLUDED (after compaction).
		{
			ID:   "turn-new-user",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("What about channels?")},
			},
		},
		{
			ID:   "turn-new-asst",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Channels connect goroutines.")},
			},
		},
	}

	messages, err := svc.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Expected: summary injection (user) + 2 post-compaction turns = 3 messages total.
	if len(messages) != 3 {
		t.Fatalf("expected 3 messages (summary + 2 post-compaction), got %d", len(messages))
	}

	// First message: injected summary as user message.
	if messages[0].Role != "user" {
		t.Errorf("first message should be user (summary), got %q", messages[0].Role)
	}
	if len(messages[0].Content) != 1 {
		t.Fatalf("summary message should have 1 block, got %d", len(messages[0].Content))
	}
	summaryBlock := messages[0].Content[0]
	if summaryBlock.TextContent == nil || !containsStr(*summaryBlock.TextContent, summary) {
		t.Errorf("summary block should contain the summary text; got: %v", summaryBlock.TextContent)
	}

	// Remaining messages: post-compaction turns (not the compaction turn itself).
	if messages[1].Role != "user" {
		t.Errorf("expected second message role=user, got %q", messages[1].Role)
	}
	if messages[2].Role != "assistant" {
		t.Errorf("expected third message role=assistant, got %q", messages[2].Role)
	}
}

// TestBuildMessages_CollapseMarker_SubstitutesCollapsedContent verifies that
// tool_result blocks before the collapse marker use collapsed_content when available.
func TestBuildMessages_CollapseMarker_SubstitutesCollapsedContent(t *testing.T) {
	svc := newTestService(t)

	collapsed := "[Read /foo/bar.go: 2048 chars]"
	fullContent := "package main\n// ... 2048 characters of source code ..."

	path := []domainllm.Turn{
		// Turn before collapse marker — tool result should use collapsed_content.
		{
			ID:   "turn-before",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "str_replace_based_edit_tool",
						"input":       map[string]interface{}{"command": "view", "path": "/foo/bar.go"},
					},
				},
				{
					BlockType:        domainllm.BlockTypeToolResult,
					CollapsedContent: ptrStr(collapsed),
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"result":      fullContent,
					},
				},
			},
		},
		// Collapse marker.
		collapseMarkerTurn("collapse-1"),
		// Turn after collapse marker — tool result should use original content.
		{
			ID:   "turn-after",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-2",
						"tool_name":   "str_replace_based_edit_tool",
						"input":       map[string]interface{}{"command": "view", "path": "/foo/baz.go"},
					},
				},
				{
					BlockType: domainllm.BlockTypeToolResult,
					Content: map[string]interface{}{
						"tool_use_id": "call-2",
						"result":      "short result",
					},
				},
			},
		},
	}

	messages, err := svc.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Expected: 2 messages (before + after; collapse marker itself is skipped).
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	// First message (before collapse marker): tool_result should use collapsed_content.
	beforeMsg := messages[0]
	var foundToolResult bool
	for _, blk := range beforeMsg.Content {
		if blk.BlockType == domainllm.BlockTypeToolResult {
			foundToolResult = true
			result, _ := blk.Content["result"].(string)
			if result != collapsed {
				t.Errorf("tool_result before collapse marker: got result=%q, want collapsed=%q", result, collapsed)
			}
		}
	}
	if !foundToolResult {
		t.Error("expected tool_result block in the before-collapse-marker message")
	}

	// Second message (after collapse marker): tool_result should have original content.
	afterMsg := messages[1]
	for _, blk := range afterMsg.Content {
		if blk.BlockType == domainllm.BlockTypeToolResult {
			result, _ := blk.Content["result"].(string)
			if result != "short result" {
				t.Errorf("tool_result after collapse marker: got result=%q, want %q", result, "short result")
			}
		}
	}
}

// TestBuildMessages_BothBookmarks verifies that when both a compaction turn and a
// collapse marker are present, the compaction cutoff takes effect and the collapse
// marker logic applies only within the effective (post-compaction) path.
func TestBuildMessages_BothBookmarks(t *testing.T) {
	svc := newTestService(t)

	const compSummary = "Previously: user set up a Go project."
	collapsed := "[Created main.go: 100 chars]"

	path := []domainllm.Turn{
		// Very old turn — skipped by compaction.
		{
			ID:   "turn-ancient",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Set up a Go project.")},
			},
		},
		// Compaction bookmark.
		compactionTurn("compaction-1", compSummary),
		// Turn after compaction, before collapse marker — tool result should be collapsed.
		{
			ID:   "turn-mid",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "str_replace_based_edit_tool",
						"input":       map[string]interface{}{},
					},
				},
				{
					BlockType:        domainllm.BlockTypeToolResult,
					CollapsedContent: ptrStr(collapsed),
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"result":      "very long file content",
					},
				},
			},
		},
		// Collapse marker.
		collapseMarkerTurn("collapse-1"),
		// Turn after collapse marker — not collapsed.
		{
			ID:   "turn-latest",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("What next?")},
			},
		},
	}

	messages, err := svc.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Expected: summary (user) + mid (assistant) + latest (user) = 3 messages.
	if len(messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(messages))
	}

	// First: compaction summary.
	if messages[0].Role != "user" {
		t.Errorf("first message should be user (summary), got %q", messages[0].Role)
	}
	if messages[0].Content[0].TextContent == nil {
		t.Fatal("summary message missing text content")
	}
	if !containsStr(*messages[0].Content[0].TextContent, compSummary) {
		t.Errorf("summary not found in first message: %q", *messages[0].Content[0].TextContent)
	}

	// Second: mid turn with collapsed tool result.
	if messages[1].Role != "assistant" {
		t.Errorf("second message should be assistant, got %q", messages[1].Role)
	}
	for _, blk := range messages[1].Content {
		if blk.BlockType == domainllm.BlockTypeToolResult {
			result, _ := blk.Content["result"].(string)
			if result != collapsed {
				t.Errorf("mid turn tool_result should be collapsed: got %q want %q", result, collapsed)
			}
		}
	}

	// Third: latest user turn.
	if messages[2].Role != "user" {
		t.Errorf("third message should be user, got %q", messages[2].Role)
	}
}

// TestBuildMessages_CollapseMarker_BeforeCompaction_Ignored verifies that a collapse
// marker appearing before the compaction turn is superseded by the compaction cutoff
// and has no effect on the output.
func TestBuildMessages_CollapseMarker_BeforeCompaction_Ignored(t *testing.T) {
	svc := newTestService(t)

	const compSummary = "Summary of everything."

	path := []domainllm.Turn{
		// Collapse marker before compaction — should be irrelevant.
		collapseMarkerTurn("collapse-early"),
		{
			ID:   "turn-old",
			Role: "assistant",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"tool_name":   "some_tool",
						"input":       map[string]interface{}{},
					},
				},
				{
					BlockType:        domainllm.BlockTypeToolResult,
					CollapsedContent: ptrStr("[collapsed]"),
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"result":      "full content",
					},
				},
			},
		},
		// Compaction supersedes the early collapse marker.
		compactionTurn("compaction-1", compSummary),
		// Only this turn and the summary injection should appear in output.
		{
			ID:   "turn-new",
			Role: "user",
			Blocks: []domainllm.TurnBlock{
				{BlockType: domainllm.BlockTypeText, TextContent: ptrStr("Continue.")},
			},
		},
	}

	messages, err := svc.BuildMessages(context.Background(), path)
	if err != nil {
		t.Fatalf("BuildMessages failed: %v", err)
	}

	// Expected: summary (user) + new user turn = 2 messages.
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}
	if !containsStr(*messages[0].Content[0].TextContent, compSummary) {
		t.Errorf("first message should contain compaction summary")
	}
}

// containsStr is a helper for substring checks in tests.
func containsStr(s, sub string) bool {
	return strings.Contains(s, sub)
}
