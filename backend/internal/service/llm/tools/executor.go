package tools

import "context"

// ToolExecutor defines the interface for executing a tool.
// Implementations must be thread-safe and respect context cancellation.
type ToolExecutor interface {
	// Execute runs the tool with the given input parameters.
	// The input map contains the tool-specific parameters as specified in the tool schema.
	// The returned interface{} must be JSON-serializable (maps, slices, primitives).
	// Returns an error if execution fails or context is cancelled.
	Execute(ctx context.Context, input map[string]interface{}) (interface{}, error)
}
