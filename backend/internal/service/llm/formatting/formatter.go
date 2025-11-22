package formatting

import "sync"

// ToolResultFormatter transforms tool results for LLM consumption.
// Each tool can implement custom formatting logic (e.g., filtering fields,
// formatting output, enriching data) before results are sent to the LLM.
type ToolResultFormatter interface {
	// Format transforms a tool result into LLM-friendly format.
	// The result parameter is the raw tool output (any type).
	// Returns the formatted result (any type).
	Format(result interface{}) interface{}
}

// FormatterRegistry manages tool result formatters.
// It allows registering formatters for specific tools and applying them
// during message building. This keeps tool-specific formatting logic
// separate from the generic library layer.
type FormatterRegistry struct {
	mu         sync.RWMutex
	formatters map[string]ToolResultFormatter
}

// NewFormatterRegistry creates a new formatter registry.
func NewFormatterRegistry() *FormatterRegistry {
	return &FormatterRegistry{
		formatters: make(map[string]ToolResultFormatter),
	}
}

// Register adds a formatter for a specific tool.
// If a formatter for the tool already exists, it will be replaced.
func (r *FormatterRegistry) Register(toolName string, formatter ToolResultFormatter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.formatters[toolName] = formatter
}

// GetFormatter retrieves a formatter by tool name.
// Returns nil if no formatter is registered for the tool.
func (r *FormatterRegistry) GetFormatter(toolName string) ToolResultFormatter {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.formatters[toolName]
}

// Format applies the registered formatter for a tool.
// If no formatter is registered, returns the result unchanged.
func (r *FormatterRegistry) Format(toolName string, result interface{}) interface{} {
	formatter := r.GetFormatter(toolName)
	if formatter == nil {
		// No formatter registered - pass through unchanged
		return result
	}
	return formatter.Format(result)
}
