package tools

// ToolConfig centralizes configuration for all tools.
// Replaces magic numbers scattered throughout tool implementations.
type ToolConfig struct {
	// View tool configuration
	MaxContentSize int // Maximum document content size to return (prevents token overflow)

	// Search tool configuration
	SearchDefaultLimit int // Default number of search results
	SearchMaxLimit     int // Maximum allowed search results

	// Tree tool configuration
	TreeDefaultDepth int // Default tree traversal depth
	TreeMaxDepth     int // Maximum allowed tree traversal depth

	// Web search tool configuration (external APIs)
	WebSearchDefaultLimit int // Default number of web search results
	WebSearchMaxLimit     int // Maximum allowed web search results
}

// DefaultToolConfig returns the default tool configuration.
func DefaultToolConfig() *ToolConfig {
	return &ToolConfig{
		// View tool defaults
		MaxContentSize: 20000, // 20k characters (~5k tokens)

		// Search tool defaults
		SearchDefaultLimit: 5,
		SearchMaxLimit:     20,

		// Tree tool defaults
		TreeDefaultDepth: 2,
		TreeMaxDepth:     5,

		// Web search tool defaults
		WebSearchDefaultLimit: 5,
		WebSearchMaxLimit:     10,
	}
}
