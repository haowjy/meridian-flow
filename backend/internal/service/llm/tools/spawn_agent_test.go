package tools

import (
	"context"
	"errors"
	"fmt"
	"testing"

	domainerrors "meridian/internal/domain/errors"
	domainllm "meridian/internal/domain/llm"
)

// --- Mock SpawnInvoker ---

type mockSpawnInvoker struct {
	createFn func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error)
}

func (m *mockSpawnInvoker) CreateSpawn(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
	if m.createFn != nil {
		return m.createFn(ctx, req)
	}
	return &domainllm.SpawnResult{
		ChildThreadID: "child-thread-123",
		Status:        "succeeded",
		Summary:       "Task completed",
	}, nil
}

func (m *mockSpawnInvoker) GetSpawnStatus(ctx context.Context, parentThreadID, childThreadID string) (*domainllm.SpawnResult, error) {
	return nil, errors.New("not implemented in mock")
}

func (m *mockSpawnInvoker) CancelSpawn(ctx context.Context, parentThreadID, childThreadID string) error {
	return errors.New("not implemented in mock")
}

// --- Helpers ---

func newTestSpawnTool(invoker domainllm.SpawnInvoker) *SpawnAgentTool {
	return NewSpawnAgentTool(
		"parent-thread-id",
		"work-item-id",
		"project-id",
		"user-id",
		invoker,
	)
}

// --- Tests ---

func TestSpawnAgentToolMetadata(t *testing.T) {
	meta := SpawnAgentToolMetadata()
	if meta == nil {
		t.Fatal("SpawnAgentToolMetadata returned nil")
	}
	if meta.Name != "spawn_agent" {
		t.Errorf("Name = %q, want %q", meta.Name, "spawn_agent")
	}
	if meta.Description == "" {
		t.Error("Description should not be empty")
	}
}

func TestNewSpawnAgentTool(t *testing.T) {
	invoker := &mockSpawnInvoker{}
	tool := NewSpawnAgentTool("parent", "work-item", "project", "user", invoker)
	if tool == nil {
		t.Fatal("NewSpawnAgentTool returned nil")
	}
	if tool.parentThreadID != "parent" {
		t.Errorf("parentThreadID = %q, want %q", tool.parentThreadID, "parent")
	}
	if tool.workItemID != "work-item" {
		t.Errorf("workItemID = %q, want %q", tool.workItemID, "work-item")
	}
	if tool.projectID != "project" {
		t.Errorf("projectID = %q, want %q", tool.projectID, "project")
	}
	if tool.userID != "user" {
		t.Errorf("userID = %q, want %q", tool.userID, "user")
	}
	if tool.spawnInvoker != invoker {
		t.Error("spawnInvoker mismatch")
	}
}

func TestSpawnAgentTool_Execute_MissingAgent(t *testing.T) {
	tool := newTestSpawnTool(&mockSpawnInvoker{})
	ctx := context.Background()

	// Missing agent key entirely
	result, err := tool.Execute(ctx, map[string]interface{}{
		"prompt": "Do the thing",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["success"] != false {
		t.Errorf("expected success=false, got %v", errMap["success"])
	}
	if errMap["error_code"] != ErrMissingParam {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], ErrMissingParam)
	}
}

func TestSpawnAgentTool_Execute_EmptyAgent(t *testing.T) {
	tool := newTestSpawnTool(&mockSpawnInvoker{})
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "   ", // whitespace-only
		"prompt": "Do the thing",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["error_code"] != ErrMissingParam {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], ErrMissingParam)
	}
}

func TestSpawnAgentTool_Execute_MissingPrompt(t *testing.T) {
	tool := newTestSpawnTool(&mockSpawnInvoker{})
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent": "coder",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["error_code"] != ErrMissingParam {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], ErrMissingParam)
	}
}

func TestSpawnAgentTool_Execute_EmptyPrompt(t *testing.T) {
	tool := newTestSpawnTool(&mockSpawnInvoker{})
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "coder",
		"prompt": "",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["error_code"] != ErrMissingParam {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], ErrMissingParam)
	}
}

func TestSpawnAgentTool_Execute_Success(t *testing.T) {
	var capturedReq *domainllm.SpawnRequest
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			capturedReq = req
			return &domainllm.SpawnResult{
				ChildThreadID: "child-abc",
				Status:        "succeeded",
				Summary:       "Wrote 3 chapters",
				Artifacts:     []string{"chapter-40.md"},
			}, nil
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "coder",
		"prompt": "Implement feature X",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify the spawn request was populated correctly.
	if capturedReq == nil {
		t.Fatal("CreateSpawn was not called")
	}
	if capturedReq.AgentSlug != "coder" {
		t.Errorf("AgentSlug = %q, want %q", capturedReq.AgentSlug, "coder")
	}
	if capturedReq.Prompt != "Implement feature X" {
		t.Errorf("Prompt = %q, want %q", capturedReq.Prompt, "Implement feature X")
	}
	if capturedReq.ParentThreadID != "parent-thread-id" {
		t.Errorf("ParentThreadID = %q, want %q", capturedReq.ParentThreadID, "parent-thread-id")
	}
	if capturedReq.WorkItemID != "work-item-id" {
		t.Errorf("WorkItemID = %q, want %q", capturedReq.WorkItemID, "work-item-id")
	}

	// Verify the result map shape.
	out, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if out["success"] != true {
		t.Errorf("success = %v, want true", out["success"])
	}
	if out["child_thread_id"] != "child-abc" {
		t.Errorf("child_thread_id = %v, want %q", out["child_thread_id"], "child-abc")
	}
	if out["status"] != "succeeded" {
		t.Errorf("status = %v, want %q", out["status"], "succeeded")
	}
	if out["summary"] != "Wrote 3 chapters" {
		t.Errorf("summary = %v, want %q", out["summary"], "Wrote 3 chapters")
	}
	artifacts, ok := out["artifacts"].([]string)
	if !ok || len(artifacts) != 1 || artifacts[0] != "chapter-40.md" {
		t.Errorf("artifacts = %v, want [chapter-40.md]", out["artifacts"])
	}
}

func TestSpawnAgentTool_Execute_Success_NoOptionalFields(t *testing.T) {
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			return &domainllm.SpawnResult{
				ChildThreadID: "child-xyz",
				Status:        "succeeded",
				// No Summary, Artifacts, or Metadata
			}, nil
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "reviewer",
		"prompt": "Review this code",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	out, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	// summary, artifacts, metadata should be absent (not zero-valued) when empty
	if _, exists := out["summary"]; exists {
		t.Error("summary should be absent when empty")
	}
	if _, exists := out["artifacts"]; exists {
		t.Error("artifacts should be absent when empty")
	}
	if _, exists := out["metadata"]; exists {
		t.Error("metadata should be absent when empty")
	}
}

func TestSpawnAgentTool_Execute_SpawnDepthExceeded(t *testing.T) {
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			return nil, domainerrors.SpawnDepthExceeded(3)
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "coder",
		"prompt": "Do something",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v — should return ErrorResult, not error", err)
	}

	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["success"] != false {
		t.Errorf("success = %v, want false", errMap["success"])
	}
	if errMap["error_code"] != domainerrors.CodeSpawnDepthExceeded {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], domainerrors.CodeSpawnDepthExceeded)
	}
}

func TestSpawnAgentTool_Execute_SpawnLimitExceeded(t *testing.T) {
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			return nil, domainerrors.SpawnLimitExceeded()
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	result, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "coder",
		"prompt": "Do something",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v — should return ErrorResult, not error", err)
	}

	errMap, ok := result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected map result, got %T", result)
	}
	if errMap["success"] != false {
		t.Errorf("success = %v, want false", errMap["success"])
	}
	if errMap["error_code"] != domainerrors.CodeSpawnLimitExceeded {
		t.Errorf("error_code = %v, want %q", errMap["error_code"], domainerrors.CodeSpawnLimitExceeded)
	}
}

func TestSpawnAgentTool_Execute_InfrastructureError(t *testing.T) {
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			return nil, fmt.Errorf("database connection lost")
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	_, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "coder",
		"prompt": "Do something",
	})
	if err == nil {
		t.Fatal("expected error for infrastructure failure")
	}
}

func TestSpawnAgentTool_Execute_TrimsWhitespace(t *testing.T) {
	var capturedReq *domainllm.SpawnRequest
	invoker := &mockSpawnInvoker{
		createFn: func(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
			capturedReq = req
			return &domainllm.SpawnResult{
				ChildThreadID: "child-trim",
				Status:        "succeeded",
			}, nil
		},
	}
	tool := newTestSpawnTool(invoker)
	ctx := context.Background()

	_, err := tool.Execute(ctx, map[string]interface{}{
		"agent":  "  coder  ",
		"prompt": "\n  Do the thing  \n",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedReq == nil {
		t.Fatal("CreateSpawn not called")
	}
	if capturedReq.AgentSlug != "coder" {
		t.Errorf("AgentSlug = %q, want %q (should be trimmed)", capturedReq.AgentSlug, "coder")
	}
	if capturedReq.Prompt != "Do the thing" {
		t.Errorf("Prompt = %q, want %q (should be trimmed)", capturedReq.Prompt, "Do the thing")
	}
}
