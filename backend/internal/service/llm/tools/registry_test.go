package tools

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// mockTool is a test implementation of ToolExecutor.
type mockTool struct {
	name       string
	delay      time.Duration
	shouldFail bool
	execCount  int
	mu         sync.Mutex
}

func (m *mockTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	m.mu.Lock()
	m.execCount++
	m.mu.Unlock()

	// Simulate work with delay
	if m.delay > 0 {
		select {
		case <-time.After(m.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	if m.shouldFail {
		return nil, errors.New("mock tool failed")
	}

	return map[string]interface{}{
		"tool":  m.name,
		"input": input,
	}, nil
}

func (m *mockTool) getExecCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.execCount
}

func TestNewToolRegistry(t *testing.T) {
	registry := NewToolRegistry()
	if registry == nil {
		t.Fatal("NewToolRegistry returned nil")
	}
	if registry.executors == nil {
		t.Fatal("registry.executors is nil")
	}
}

func TestToolRegistry_RegisterAndGet(t *testing.T) {
	registry := NewToolRegistry()
	tool := &mockTool{name: "test_tool"}

	// Register the tool
	registry.Register("test_tool", tool)

	// Retrieve the tool
	retrieved := registry.Get("test_tool")
	if retrieved == nil {
		t.Fatal("Get returned nil for registered tool")
	}
	if retrieved != tool {
		t.Error("Get returned different tool instance")
	}

	// Try to get a non-existent tool
	nonExistent := registry.Get("non_existent")
	if nonExistent != nil {
		t.Error("Get returned non-nil for non-existent tool")
	}
}

func TestToolRegistry_Execute(t *testing.T) {
	registry := NewToolRegistry()
	ctx := context.Background()

	t.Run("successful execution", func(t *testing.T) {
		tool := &mockTool{name: "success_tool"}
		registry.Register("success_tool", tool)

		call := ToolCall{
			ID:    "call_1",
			Name:  "success_tool",
			Input: map[string]interface{}{"param": "value"},
		}

		result := registry.Execute(ctx, call)

		if result.IsError {
			t.Errorf("expected success, got error: %v", result.Error)
		}
		if result.ID != "call_1" {
			t.Errorf("expected ID 'call_1', got %s", result.ID)
		}
		if result.Result == nil {
			t.Error("expected non-nil result")
		}
	})

	t.Run("tool not found", func(t *testing.T) {
		call := ToolCall{
			ID:   "call_2",
			Name: "non_existent_tool",
		}

		result := registry.Execute(ctx, call)

		if !result.IsError {
			t.Error("expected error for non-existent tool")
		}
		if result.Error == nil {
			t.Error("expected non-nil error")
		}
		if result.ID != "call_2" {
			t.Errorf("expected ID 'call_2', got %s", result.ID)
		}
	})

	t.Run("tool execution failure", func(t *testing.T) {
		tool := &mockTool{name: "fail_tool", shouldFail: true}
		registry.Register("fail_tool", tool)

		call := ToolCall{
			ID:   "call_3",
			Name: "fail_tool",
		}

		result := registry.Execute(ctx, call)

		if !result.IsError {
			t.Error("expected error for failed tool execution")
		}
		if result.Error == nil {
			t.Error("expected non-nil error")
		}
	})

	t.Run("context cancellation", func(t *testing.T) {
		tool := &mockTool{name: "slow_tool", delay: 500 * time.Millisecond}
		registry.Register("slow_tool", tool)

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // Cancel immediately

		call := ToolCall{
			ID:   "call_4",
			Name: "slow_tool",
		}

		result := registry.Execute(ctx, call)

		if !result.IsError {
			t.Error("expected error for cancelled context")
		}
		if !errors.Is(result.Error, context.Canceled) {
			t.Errorf("expected context.Canceled error, got: %v", result.Error)
		}
	})
}

func TestToolRegistry_ExecuteParallel(t *testing.T) {
	t.Run("empty calls", func(t *testing.T) {
		registry := NewToolRegistry()
		results := registry.ExecuteParallel(context.Background(), []ToolCall{})

		if len(results) != 0 {
			t.Errorf("expected 0 results, got %d", len(results))
		}
	})

	t.Run("single tool", func(t *testing.T) {
		registry := NewToolRegistry()
		tool := &mockTool{name: "single_tool"}
		registry.Register("single_tool", tool)

		calls := []ToolCall{
			{ID: "call_1", Name: "single_tool", Input: map[string]interface{}{"x": 1}},
		}

		results := registry.ExecuteParallel(context.Background(), calls)

		if len(results) != 1 {
			t.Fatalf("expected 1 result, got %d", len(results))
		}
		if results[0].IsError {
			t.Errorf("unexpected error: %v", results[0].Error)
		}
	})

	t.Run("parallel execution is faster than serial", func(t *testing.T) {
		registry := NewToolRegistry()

		// Create 3 tools that each take 100ms
		for i := 0; i < 3; i++ {
			tool := &mockTool{
				name:  fmt.Sprintf("tool_%d", i),
				delay: 100 * time.Millisecond,
			}
			registry.Register(fmt.Sprintf("tool_%d", i), tool)
		}

		calls := []ToolCall{
			{ID: "call_0", Name: "tool_0"},
			{ID: "call_1", Name: "tool_1"},
			{ID: "call_2", Name: "tool_2"},
		}

		start := time.Now()
		results := registry.ExecuteParallel(context.Background(), calls)
		elapsed := time.Since(start)

		// Parallel execution should take ~100ms (not ~300ms for serial)
		// Allow some overhead, so check if it's less than 200ms
		if elapsed > 200*time.Millisecond {
			t.Errorf("parallel execution took too long: %v (expected < 200ms)", elapsed)
		}

		if len(results) != 3 {
			t.Fatalf("expected 3 results, got %d", len(results))
		}

		for i, result := range results {
			if result.IsError {
				t.Errorf("result %d has error: %v", i, result.Error)
			}
		}
	})

	t.Run("order preservation", func(t *testing.T) {
		registry := NewToolRegistry()

		// Create tools with different delays to ensure they finish in different orders
		delays := []time.Duration{
			50 * time.Millisecond,  // tool_0 finishes second
			10 * time.Millisecond,  // tool_1 finishes first
			100 * time.Millisecond, // tool_2 finishes last
		}

		for i, delay := range delays {
			tool := &mockTool{
				name:  fmt.Sprintf("tool_%d", i),
				delay: delay,
			}
			registry.Register(fmt.Sprintf("tool_%d", i), tool)
		}

		calls := []ToolCall{
			{ID: "call_0", Name: "tool_0"},
			{ID: "call_1", Name: "tool_1"},
			{ID: "call_2", Name: "tool_2"},
		}

		results := registry.ExecuteParallel(context.Background(), calls)

		// Verify results are in the same order as calls
		if len(results) != 3 {
			t.Fatalf("expected 3 results, got %d", len(results))
		}

		for i, result := range results {
			expectedID := fmt.Sprintf("call_%d", i)
			if result.ID != expectedID {
				t.Errorf("result %d has wrong ID: got %s, expected %s", i, result.ID, expectedID)
			}

			if result.IsError {
				t.Errorf("result %d has error: %v", i, result.Error)
			}

			// Verify the result contains the correct tool name
			resultMap, ok := result.Result.(map[string]interface{})
			if !ok {
				t.Errorf("result %d is not a map", i)
				continue
			}
			expectedToolName := fmt.Sprintf("tool_%d", i)
			if resultMap["tool"] != expectedToolName {
				t.Errorf("result %d has wrong tool name: got %v, expected %s", i, resultMap["tool"], expectedToolName)
			}
		}
	})

	t.Run("context cancellation propagation", func(t *testing.T) {
		registry := NewToolRegistry()

		// Create tools with significant delays
		for i := 0; i < 3; i++ {
			tool := &mockTool{
				name:  fmt.Sprintf("tool_%d", i),
				delay: 500 * time.Millisecond,
			}
			registry.Register(fmt.Sprintf("tool_%d", i), tool)
		}

		calls := []ToolCall{
			{ID: "call_0", Name: "tool_0"},
			{ID: "call_1", Name: "tool_1"},
			{ID: "call_2", Name: "tool_2"},
		}

		ctx, cancel := context.WithCancel(context.Background())
		cancel() // Cancel immediately

		results := registry.ExecuteParallel(ctx, calls)

		// All results should have context cancellation errors
		for i, result := range results {
			if !result.IsError {
				t.Errorf("result %d should have error due to context cancellation", i)
			}
			if result.Error != nil && !errors.Is(result.Error, context.Canceled) {
				t.Errorf("result %d has wrong error type: %v", i, result.Error)
			}
		}
	})

	t.Run("mixed success and failure", func(t *testing.T) {
		registry := NewToolRegistry()

		registry.Register("success_tool", &mockTool{name: "success_tool"})
		registry.Register("fail_tool", &mockTool{name: "fail_tool", shouldFail: true})

		calls := []ToolCall{
			{ID: "call_0", Name: "success_tool"},
			{ID: "call_1", Name: "fail_tool"},
			{ID: "call_2", Name: "non_existent"},
			{ID: "call_3", Name: "success_tool"},
		}

		results := registry.ExecuteParallel(context.Background(), calls)

		if len(results) != 4 {
			t.Fatalf("expected 4 results, got %d", len(results))
		}

		// Check result 0 (success)
		if results[0].IsError {
			t.Errorf("result 0 should succeed, got error: %v", results[0].Error)
		}

		// Check result 1 (failure)
		if !results[1].IsError {
			t.Error("result 1 should fail")
		}

		// Check result 2 (not found)
		if !results[2].IsError {
			t.Error("result 2 should fail (tool not found)")
		}

		// Check result 3 (success)
		if results[3].IsError {
			t.Errorf("result 3 should succeed, got error: %v", results[3].Error)
		}
	})

	t.Run("high concurrency thread-safety", func(t *testing.T) {
		registry := NewToolRegistry()

		// Register a single tool that will be called many times concurrently
		tool := &mockTool{name: "concurrent_tool"}
		registry.Register("concurrent_tool", tool)

		// Create 100 concurrent calls
		calls := make([]ToolCall, 100)
		for i := 0; i < 100; i++ {
			calls[i] = ToolCall{
				ID:    fmt.Sprintf("call_%d", i),
				Name:  "concurrent_tool",
				Input: map[string]interface{}{"index": i},
			}
		}

		results := registry.ExecuteParallel(context.Background(), calls)

		if len(results) != 100 {
			t.Fatalf("expected 100 results, got %d", len(results))
		}

		// Verify all executions succeeded
		for i, result := range results {
			if result.IsError {
				t.Errorf("result %d has error: %v", i, result.Error)
			}
			expectedID := fmt.Sprintf("call_%d", i)
			if result.ID != expectedID {
				t.Errorf("result %d has wrong ID: got %s, expected %s", i, result.ID, expectedID)
			}
		}

		// Verify the tool was executed exactly 100 times
		if tool.getExecCount() != 100 {
			t.Errorf("expected 100 executions, got %d", tool.getExecCount())
		}
	})
}

func TestToolRegistry_ConcurrentRegisterAndGet(t *testing.T) {
	registry := NewToolRegistry()
	var wg sync.WaitGroup

	// Concurrently register and get tools
	for i := 0; i < 50; i++ {
		wg.Add(2)

		// Register
		go func(index int) {
			defer wg.Done()
			tool := &mockTool{name: fmt.Sprintf("tool_%d", index)}
			registry.Register(fmt.Sprintf("tool_%d", index), tool)
		}(i)

		// Get
		go func(index int) {
			defer wg.Done()
			// May or may not find the tool depending on race
			_ = registry.Get(fmt.Sprintf("tool_%d", index))
		}(i)
	}

	wg.Wait()

	// Verify all tools are registered
	for i := 0; i < 50; i++ {
		tool := registry.Get(fmt.Sprintf("tool_%d", i))
		if tool == nil {
			t.Errorf("tool_%d not found after concurrent registration", i)
		}
	}
}
