package tools

import (
	"context"
	"fmt"
	"sort"
	"strings"
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

// ToolWithMetadata bundles a tool executor with its metadata for system prompt generation.
// This enables OCP compliance - tools self-describe rather than being described in a central map.
type ToolWithMetadata struct {
	Executor ToolExecutor
	Metadata *ToolMetadata
}

// ToolRegistry manages tool executors and handles tool execution.
// It is thread-safe and can be used concurrently.
// Tools are stored with metadata to enable dynamic system prompt generation (OCP compliance).
type ToolRegistry struct {
	mu    sync.RWMutex
	tools map[string]ToolWithMetadata
}

// NewToolRegistry creates a new tool registry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{
		tools: make(map[string]ToolWithMetadata),
	}
}

// RegisterWithMetadata adds a tool executor with its metadata to the registry.
// This enables OCP compliance - tools self-describe for system prompt generation.
// If a tool with the same name already exists, it will be replaced.
func (r *ToolRegistry) RegisterWithMetadata(name string, executor ToolExecutor, metadata *ToolMetadata) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[name] = ToolWithMetadata{Executor: executor, Metadata: metadata}
}

// Get retrieves a tool executor by name.
// Returns nil if the tool is not registered.
func (r *ToolRegistry) Get(name string) ToolExecutor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if tool, ok := r.tools[name]; ok {
		return tool.Executor
	}
	return nil
}

// GetMetadata retrieves tool metadata by name.
// Returns nil if the tool is not registered or has no metadata.
func (r *ToolRegistry) GetMetadata(name string) *ToolMetadata {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if tool, ok := r.tools[name]; ok {
		return tool.Metadata
	}
	return nil
}

// GetRegisteredToolNames returns names of all registered tools.
// Names are returned in sorted order for deterministic system prompt generation.
func (r *ToolRegistry) GetRegisteredToolNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// BuildSystemPromptSection generates the tools section for the system prompt.
// Only includes tools that have metadata defined.
// Returns empty string if no tools with metadata are registered.
func (r *ToolRegistry) BuildSystemPromptSection() string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	// Collect tool descriptions and guidelines from registered tools
	var toolLines []string
	var guidelines []string

	// Use sorted order for deterministic output
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		tool := r.tools[name]
		if tool.Metadata == nil {
			continue
		}

		// Add tool description
		if tool.Metadata.Description != "" {
			toolLines = append(toolLines, fmt.Sprintf("- %s: %s", name, tool.Metadata.Description))
		}

		// Collect guideline if present
		if tool.Metadata.Guideline != "" {
			guidelines = append(guidelines, "- "+tool.Metadata.Guideline)
		}
	}

	// Build the section
	var sb strings.Builder

	// Add tools section if any tools are registered
	if len(toolLines) > 0 {
		sb.WriteString("\n\nAvailable tools:\n")
		sb.WriteString(strings.Join(toolLines, "\n"))
	}

	// Add guidelines section if any guidelines are present
	if len(guidelines) > 0 {
		sb.WriteString("\n\nGuidelines:\n")
		sb.WriteString(strings.Join(guidelines, "\n"))
		sb.WriteString("\n- Be helpful and proactive based on what you discover in their documents")
	}

	return sb.String()
}

// Prune removes all registered tools for which the keep predicate returns false.
// Call after all tool registration is complete (e.g. from builder.WithPersonaToolFilter).
// Thread-safe: acquires a write lock for the duration of the prune.
func (r *ToolRegistry) Prune(keep func(name string) bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name := range r.tools {
		if !keep(name) {
			delete(r.tools, name)
		}
	}
}

// Execute runs a single tool and returns the result.
// Returns an error if the tool is not found or execution fails.
func (r *ToolRegistry) Execute(ctx context.Context, call ToolCall) ToolResult {
	r.mu.RLock()
	tool, ok := r.tools[call.Name]
	r.mu.RUnlock()

	if !ok || tool.Executor == nil {
		return ToolResult{
			ID:      call.ID,
			Name:    call.Name,
			Result:  nil,
			Error:   fmt.Errorf("tool not found: %s", call.Name),
			IsError: true,
		}
	}

	result, err := tool.Executor.Execute(ctx, call.Input)
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
