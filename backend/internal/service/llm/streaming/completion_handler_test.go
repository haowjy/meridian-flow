package streaming

import (
	"context"
	"errors"
	"testing"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/tools"
)

func TestHandleCompletion_ToolUsePersistsAndSettlesCurrentRequestBeforeContinuation(t *testing.T) {
	t.Parallel()

	executor, store, _, settler, _ := newTerminateTestExecutor(t, domainllm.TurnStatusStreaming)
	setExecutorState(executor, StateStreaming)

	// Keep this test focused on completion boundary behavior.
	// Use metadata tokens directly (no finalizer side-effects).
	executor.tokenFinalizer = nil
	executor.toolRegistry = tools.NewToolRegistry()
	executor.collectedTools = []tools.ToolCall{
		{ID: "tool-1", Name: "unused_tool", Input: map[string]interface{}{}},
	}
	// Mark tool result as already present so no actual tool execution is attempted.
	executor.toolResultIDs["tool-1"] = true
	// Stop before continuation request construction (which is outside this test's scope).
	executor.creditAdmissionChecker = &mockCreditAdmissionChecker{err: errors.New("insufficient credits")}

	metadata := &domainllm.StreamMetadata{
		Model:        "test-model",
		StopReason:   "tool_use",
		InputTokens:  13,
		OutputTokens: 8,
	}

	if err := executor.handleCompletion(context.Background(), nil, metadata); err != nil {
		t.Fatalf("handleCompletion() error = %v", err)
	}

	if got := len(store.tokenUpdateCalls); got != 1 {
		t.Fatalf("token metadata persist calls = %d, want 1", got)
	}
	persistCall := store.tokenUpdateCalls[0]
	if persistCall.tokens.InputTokens != 13 || persistCall.tokens.OutputTokens != 8 {
		t.Fatalf("persisted tokens = (%d,%d), want (13,8)", persistCall.tokens.InputTokens, persistCall.tokens.OutputTokens)
	}

	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("billing settlement calls = %d, want 1", got)
	}
	if settler.settleCalls[0].RequestIndex != 0 {
		t.Fatalf("settled request_index = %d, want 0 (current request before continuation increment)", settler.settleCalls[0].RequestIndex)
	}
}
