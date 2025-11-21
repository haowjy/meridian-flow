package llm

import (
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
)

// FunctionDetails represents the function definition (OpenAI format)
type FunctionDetails struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters"`
}

// ToolDefinition represents a tool definition as received from HTTP JSON.
// This is the backend's intermediate format that matches what users send.
//
// Supports two formats:
// 1. Minimal (built-in tool) - auto-maps to provider's built-in:
//    {"name": "web_search"}
//
// 2. Full OpenAI format (custom tool):
//    {
//      "type": "function",
//      "function": {
//        "name": "get_weather",
//        "description": "Get weather for a location",
//        "parameters": {
//          "type": "object",
//          "properties": {...},
//          "required": [...]
//        }
//      }
//    }
type ToolDefinition struct {
	// Type should be "function" for OpenAI format (optional for minimal format)
	Type string `json:"type,omitempty"`

	// Name is the tool identifier (for minimal format only)
	// For full format, use Function.Name instead
	Name string `json:"name,omitempty"`

	// Function contains the full function definition (OpenAI format)
	// Present only for custom tools in full format
	Function *FunctionDetails `json:"function,omitempty"`
}

// ToLibraryTool converts the backend ToolDefinition to a library Tool type
// using the appropriate constructor (NewCustomTool or MapToolByName).
//
// Detection logic:
//   - If Function field is present → Create custom tool (OpenAI format)
//   - Else if Name is present → Map to built-in tool by name (minimal format)
func (td *ToolDefinition) ToLibraryTool() (*llmprovider.Tool, error) {
	// Full OpenAI format: {"type": "function", "function": {...}}
	if td.Function != nil {
		if td.Function.Name == "" {
			return nil, fmt.Errorf("function name is required")
		}
		if td.Function.Parameters == nil {
			return nil, fmt.Errorf("function parameters are required")
		}

		// Custom tool - use library constructor with OpenAI format
		tool, err := llmprovider.NewCustomTool(
			td.Function.Name,
			td.Function.Description,
			td.Function.Parameters,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to create custom tool '%s': %w", td.Function.Name, err)
		}
		return tool, nil
	}

	// Minimal format: {"name": "web_search"}
	if td.Name != "" {
		// Built-in tool - use library mapper
		tool, err := llmprovider.MapToolByName(td.Name)
		if err != nil {
			return nil, fmt.Errorf("failed to map built-in tool '%s': %w", td.Name, err)
		}
		return tool, nil
	}

	return nil, fmt.Errorf("tool definition must have either 'function' or 'name' field")
}

// ToLibraryTools converts a slice of ToolDefinitions to library Tool types
func ToLibraryTools(definitions []ToolDefinition) ([]llmprovider.Tool, error) {
	if len(definitions) == 0 {
		return nil, nil
	}

	tools := make([]llmprovider.Tool, len(definitions))
	for i, def := range definitions {
		tool, err := def.ToLibraryTool()
		if err != nil {
			return nil, fmt.Errorf("tool %d: %w", i, err)
		}
		tools[i] = *tool
	}
	return tools, nil
}

// GetReadOnlyToolDefinitions returns the tool definitions for read-only document tools.
// These tools allow the LLM to explore the user's document repository.
func GetReadOnlyToolDefinitions() []ToolDefinition {
	return []ToolDefinition{
		getViewToolDefinition(),
		getTreeToolDefinition(),
		getSearchToolDefinition(),
	}
}

// getViewToolDefinition returns the schema for the 'doc_view' tool.
// This tool reads a document's content or lists a folder's contents.
func getViewToolDefinition() ToolDefinition {
	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "doc_view",
			Description: "Read the contents of a document or list the contents of a folder. Use this to access files in the user's document repository.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "The Unix-style path to the document or folder (e.g., '/chapter-1.txt', '/drafts/outline.md', '/drafts'). Use '/' for the root folder.",
					},
				},
				"required": []string{"path"},
			},
		},
	}
}

// getTreeToolDefinition returns the schema for the 'doc_tree' tool.
// This tool shows the hierarchical structure of folders and documents.
func getTreeToolDefinition() ToolDefinition {
	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "doc_tree",
			Description: "Show the hierarchical structure of folders and documents starting from a given folder. Returns metadata only (no content). Useful for understanding the organization of the user's document repository.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"folder": map[string]interface{}{
						"type":        "string",
						"description": "The Unix-style path to the folder (e.g., '/drafts', '/chapters'). Use '/' for the root folder.",
					},
					"depth": map[string]interface{}{
						"type":        "integer",
						"description": "How many levels deep to traverse (default: 2, max: 5). Higher values show more of the hierarchy.",
						"minimum":     1,
						"maximum":     5,
					},
				},
				"required": []string{"folder"},
			},
		},
	}
}

// getSearchToolDefinition returns the schema for the 'doc_search' tool.
// This tool performs full-text search across documents.
func getSearchToolDefinition() ToolDefinition {
	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "doc_search",
			Description: "Search for documents by content or name using full-text search. Returns ranked results with metadata. Supports advanced search syntax: use OR for alternatives (e.g., 'dragon OR knight'), minus sign to exclude terms (e.g., 'dragon -fire'), and double quotes for exact phrases (e.g., '\"dark knight\"'). You can combine these (e.g., '\"dragon rider\" OR knight -villain').",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{
						"type":        "string",
						"description": "The search query. Supports Google-like syntax: 'word1 OR word2' (either term), 'word1 -word2' (exclude word2), '\"exact phrase\"' (phrase match), or combinations like '\"exact phrase\" OR keyword -excluded'.",
					},
					"folder": map[string]interface{}{
						"type":        "string",
						"description": "Optional: limit search to documents within this folder path (e.g., '/drafts'). Omit to search all documents.",
					},
				},
				"required": []string{"query"},
			},
		},
	}
}

// GetToolDefinitionByName returns the full tool definition for a given tool name.
// This is used to resolve minimal format {"name": "doc_view"} to full schemas.
// Returns nil if the tool name is not recognized as a custom read-only tool.
func GetToolDefinitionByName(name string) *ToolDefinition {
	switch name {
	case "doc_view":
		def := getViewToolDefinition()
		return &def
	case "doc_tree":
		def := getTreeToolDefinition()
		return &def
	case "doc_search":
		def := getSearchToolDefinition()
		return &def
	default:
		return nil
	}
}
