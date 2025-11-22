package tools

import (
	"context"
	"fmt"
	"sync"
)

// ToolCall represents a single tool invocation request.
type ToolCall struct {
	ID    string                 `json:"id"`    // tool_use_id from LLM
	Name  string                 `json:"name"`  // tool name
	Input map[string]interface{} `json:"input"` // tool parameters
}

// ToolResult represents the result of a tool execution.
type ToolResult struct {
	ID      string      `json:"id"`       // tool_use_id (matches ToolCall.ID)
	Name    string      `json:"name"`     // tool name (matches ToolCall.Name)
	Result  interface{} `json:"result"`   // execution result (nil if error)
	Error   error       `json:"error"`    // execution error (nil if success)
	IsError bool        `json:"is_error"` // whether execution failed
}

// ToolRegistry manages tool executors and handles tool execution.
// It is thread-safe and can be used concurrently.
type ToolRegistry struct {
	mu        sync.RWMutex
	executors map[string]ToolExecutor
}

// NewToolRegistry creates a new tool registry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{
		executors: make(map[string]ToolExecutor),
	}
}

// Register adds a tool executor to the registry.
// If a tool with the same name already exists, it will be replaced.
func (r *ToolRegistry) Register(name string, executor ToolExecutor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.executors[name] = executor
}

// Get retrieves a tool executor by name.
// Returns nil if the tool is not registered.
func (r *ToolRegistry) Get(name string) ToolExecutor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.executors[name]
}

// Execute runs a single tool and returns the result.
// Returns an error if the tool is not found or execution fails.
func (r *ToolRegistry) Execute(ctx context.Context, call ToolCall) ToolResult {
	executor := r.Get(call.Name)
	if executor == nil {
		return ToolResult{
			ID:      call.ID,
			Name:    call.Name,
			Result:  nil,
			Error:   fmt.Errorf("tool not found: %s", call.Name),
			IsError: true,
		}
	}

	result, err := executor.Execute(ctx, call.Input)
	if err != nil {
		return ToolResult{
			ID:      call.ID,
			Name:    call.Name,
			Result:  nil,
			Error:   err,
			IsError: true,
		}
	}

	return ToolResult{
		ID:      call.ID,
		Name:    call.Name,
		Result:  result,
		Error:   nil,
		IsError: false,
	}
}

// ExecuteParallel runs multiple tools concurrently and returns results in the same order.
// This method uses goroutines for parallel execution while preserving result order.
// Context cancellation will stop all ongoing executions.
func (r *ToolRegistry) ExecuteParallel(ctx context.Context, calls []ToolCall) []ToolResult {
	if len(calls) == 0 {
		return []ToolResult{}
	}

	// Pre-allocate results slice with correct length
	results := make([]ToolResult, len(calls))
	var wg sync.WaitGroup

	// Execute each tool in a separate goroutine
	for i, call := range calls {
		wg.Add(1)
		go func(index int, toolCall ToolCall) {
			defer wg.Done()

			// Check context before executing
			select {
			case <-ctx.Done():
				results[index] = ToolResult{
					ID:      toolCall.ID,
					Name:    toolCall.Name,
					Result:  nil,
					Error:   ctx.Err(),
					IsError: true,
				}
				return
			default:
			}

			// Execute the tool
			results[index] = r.Execute(ctx, toolCall)
		}(i, call)
	}

	// Wait for all executions to complete
	wg.Wait()

	return results
}
