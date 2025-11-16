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
