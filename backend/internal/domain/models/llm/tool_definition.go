package llm

import (
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
)

// FunctionDetails represents the function definition (OpenAI format)
// Uses the library's typed ToolInputSchema for type safety.
type FunctionDetails struct {
	Name        string                    `json:"name"`
	Description string                    `json:"description,omitempty"`
	Parameters  llmprovider.ToolInputSchema `json:"parameters"`
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

		// Custom tool - use library constructor with typed schema
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
		// Check if this is a web search variant (tavily_web_search, brave_web_search, etc.)
		// These should be treated as custom local tools with ExecutionSide: Local
		if isWebSearchVariant(td.Name) {
			// Get the full tool definition (all variants map to same web_search schema)
			fullDef := GetToolDefinitionByName(td.Name)
			if fullDef == nil || fullDef.Function == nil {
				return nil, fmt.Errorf("failed to resolve web search variant '%s'", td.Name)
			}

			// Create custom tool (backend execution determined by tool registry routing)
			tool, err := llmprovider.NewCustomTool(
				fullDef.Function.Name,
				fullDef.Function.Description,
				fullDef.Function.Parameters,
			)
			if err != nil {
				return nil, fmt.Errorf("failed to create web search tool '%s': %w", td.Name, err)
			}
			return tool, nil
		}

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
		getTreeToolDefinition(),
		getSearchToolDefinition(),
	}
}

// GetDocumentToolDefinitions returns all document tool definitions (read + edit).
// Includes text editor (unified view/edit), tree, and search tools.
func GetDocumentToolDefinitions() []ToolDefinition {
	return []ToolDefinition{
		getTextEditorToolDefinition(),
		getTreeToolDefinition(),
		getSearchToolDefinition(),
	}
}

// GetAllToolDefinitions returns all available tool definitions, including web search.
// Use includeWebSearch=true to add web_search tool (requires external API configured).
func GetAllToolDefinitions(includeWebSearch bool) []ToolDefinition {
	tools := GetReadOnlyToolDefinitions()

	if includeWebSearch {
		tools = append(tools, getWebSearchToolDefinition())
	}

	return tools
}

// getTextEditorToolDefinition returns the schema for the 'str_replace_based_edit_tool' tool.
// This is a unified tool that combines view and edit operations, matching Anthropic's text_editor_20250728 API.
// For Anthropic provider, this maps directly to the native text_editor tool.
//
// Schema matches Anthropic's text_editor_20250728:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
func getTextEditorToolDefinition() ToolDefinition {
	// NOTE: We intentionally control the textual order of `properties`.
	// Some providers (notably Anthropic) may stream tool input keys following the schema's
	// property order. If "file_text" appears before "path", the UI may not be able to
	// display the destination file path until very late in the stream.
	//
	// The library's OrderedProperties handles this via the Order slice.
	schema := llmprovider.NewToolInputSchema()

	// Add properties in the order we want them to appear in JSON
	// This ensures "path" appears before "file_text" in streamed output
	schema.AddProperty("command", llmprovider.PropertySchema{
		Type:        "string",
		Enum:        []string{"view", "str_replace", "create", "insert"},
		Description: "The command to execute: 'view' to read content, 'str_replace' to replace text, 'create' to make new file, 'insert' to add text at line",
	}, -1)
	schema.AddProperty("path", llmprovider.PropertySchema{
		Type:        "string",
		Description: "Unix-style path to document or folder (e.g., '/Chapter 5.md', '/characters/hero.md', '/drafts')",
	}, -1)
	schema.AddProperty("view_range", llmprovider.PropertySchema{
		Type:        "array",
		Description: "For view: optional [start_line, end_line] range. Use -1 for end_line to read to end of file.",
	}, -1)
	schema.AddProperty("file_text", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For create: initial content for the new document",
	}, -1)
	schema.AddProperty("old_str", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For str_replace: exact text to find and replace. Must match exactly, including whitespace and newlines.",
	}, -1)
	schema.AddProperty("new_str", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For str_replace/insert: replacement or insertion text. Can be empty string for str_replace (deletion).",
	}, -1)
	schema.AddProperty("insert_line", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "For insert: line number to insert after (0 = insert at start of document, before line 1)",
	}, -1)

	schema.AddRequired("command")
	schema.AddRequired("path")

	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name: "str_replace_based_edit_tool",
			Description: `View or edit documents in the user's project.

Commands:
- view: Read file contents (returns line-numbered content). For folders, lists contents.
- str_replace: Replace exact text (must match exactly, use view first)
- create: Create a new document with initial content
- insert: Insert new text after a specific line number

Notes:
- Always use 'view' first to see current content before editing
- For create: ALWAYS include both path and file_text (file_text may be empty "")
- For create (streaming UX): output path BEFORE file_text
- Changes are suggested to the user for review before being applied`,
			Parameters: schema,
		},
	}
}

// getTreeToolDefinition returns the schema for the 'doc_tree' tool.
// This tool shows the hierarchical structure of folders and documents.
func getTreeToolDefinition() ToolDefinition {
	schema := llmprovider.NewToolInputSchema()
	schema.AddProperty("path", llmprovider.PropertySchema{
		Type:        "string",
		Description: "The Unix-style path to the folder (e.g., '/drafts', '/chapters'). Defaults to '/' (root folder) if not provided.",
	}, -1)
	schema.AddProperty("depth", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "How many levels deep to traverse (default: 2, max: 5). Higher values show more of the hierarchy.",
		Minimum:     llmprovider.IntPtr(1),
		Maximum:     llmprovider.IntPtr(5),
	}, -1)

	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "doc_tree",
			Description: "Show the hierarchical structure of folders and documents starting from a given folder. Returns metadata only (no content). Useful for understanding the organization of the user's document repository.",
			Parameters:  schema,
		},
	}
}

// getSearchToolDefinition returns the schema for the 'doc_search' tool.
// This tool performs full-text search across documents.
func getSearchToolDefinition() ToolDefinition {
	schema := llmprovider.NewToolInputSchema()
	schema.AddProperty("query", llmprovider.PropertySchema{
		Type:        "string",
		Description: "The search query. Supports Google-like syntax: 'word1 OR word2' (either term), 'word1 -word2' (exclude word2), '\"exact phrase\"' (phrase match), or combinations like '\"exact phrase\" OR keyword -excluded'.",
	}, -1)
	schema.AddProperty("folder", llmprovider.PropertySchema{
		Type:        "string",
		Description: "Optional: limit search to documents within this folder path (e.g., '/drafts'). Omit to search all documents.",
	}, -1)
	schema.AddProperty("limit", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "Optional: maximum number of results to return (default: 5, max: 20).",
		Minimum:     llmprovider.IntPtr(1),
		Maximum:     llmprovider.IntPtr(20),
	}, -1)
	schema.AddProperty("offset", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "Optional: number of results to skip for pagination (default: 0).",
		Minimum:     llmprovider.IntPtr(0),
	}, -1)
	schema.AddRequired("query")

	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "doc_search",
			Description: "Search for documents by content or name using full-text search. Returns up to 'limit' results (default: 5) with matched content snippets. Use 'offset' to paginate through results. Check 'has_more' to see if additional pages exist. Supports advanced search syntax: use OR for alternatives (e.g., 'dragon OR knight'), minus sign to exclude terms (e.g., 'dragon -fire'), and double quotes for exact phrases (e.g., '\"dark knight\"'). You can combine these (e.g., '\"dragon rider\" OR knight -villain').",
			Parameters:  schema,
		},
	}
}

// getEditToolDefinition returns the schema for the 'doc_edit' tool.
// This tool edits documents by writing to ai_version for user review.
func getEditToolDefinition() ToolDefinition {
	// NOTE: We intentionally control the textual order of `properties` for `doc_edit`.
	// Some providers (notably Anthropic) may stream tool input keys following the schema's
	// property order. If "file_text" appears before "path", the UI may not be able to
	// display the destination file path until very late in the stream.
	//
	// The library's OrderedProperties handles this via the Order slice.
	schema := llmprovider.NewToolInputSchema()

	// Add properties in the order we want them to appear in JSON
	// This ensures "path" appears before "file_text" in streamed output
	schema.AddProperty("command", llmprovider.PropertySchema{
		Type:        "string",
		Enum:        []string{"str_replace", "insert", "append", "create"},
		Description: "The editing command to execute",
	}, -1)
	schema.AddProperty("path", llmprovider.PropertySchema{
		Type:        "string",
		Description: "Unix-style path to document (e.g., '/Chapter 5.md', '/characters/hero.md')",
	}, -1)
	schema.AddProperty("file_text", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For create: initial content for the new document.",
	}, -1)
	schema.AddProperty("old_str", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For str_replace: exact text to find and replace. Must match exactly, including whitespace and newlines.",
	}, -1)
	schema.AddProperty("new_str", llmprovider.PropertySchema{
		Type:        "string",
		Description: "For str_replace/insert/append: new text to insert. Can be empty string for str_replace (deletion).",
	}, -1)
	schema.AddProperty("insert_line", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "For insert: line number to insert after (0 = insert at start of document, before line 1).",
	}, -1)

	schema.AddRequired("command")
	schema.AddRequired("path")

	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name: "doc_edit",
			Description: `Edit documents in the user's project. Use this to modify, improve, or create writing.

Commands:
- str_replace: Replace exact text (must match exactly, use doc_view first to see content)
- insert: Insert new text after a specific line number
- append: Add text to end of document
- create: Create a new document

Notes:
- For create: ALWAYS include both path and file_text (file_text may be empty string ""). This avoids needing follow-up edits.
- For create (streaming UX): output path BEFORE file_text. file_text can be very long; path should be emitted early so the UI can show ` + "`Create: /file.md`" + ` while the content streams.
- Changes are suggested to the user for review before being applied. Always use doc_view first to see the current content before making edits.`,
			Parameters: schema,
		},
	}
}

// getWebSearchToolDefinition returns the schema for the 'web_search' tool.
// This tool searches the web using external APIs (Tavily, Brave, Serper, etc.).
func getWebSearchToolDefinition() ToolDefinition {
	schema := llmprovider.NewToolInputSchema()
	schema.AddProperty("query", llmprovider.PropertySchema{
		Type:        "string",
		Description: "The search query. Be specific and use relevant keywords for best results.",
	}, -1)
	schema.AddProperty("max_results", llmprovider.PropertySchema{
		Type:        "integer",
		Description: "Optional: maximum number of results to return (default: 5, max: 10).",
		Minimum:     llmprovider.IntPtr(1),
		Maximum:     llmprovider.IntPtr(10),
	}, -1)
	schema.AddProperty("topic", llmprovider.PropertySchema{
		Type:        "string",
		Enum:        []string{"general", "news", "finance"},
		Description: "Optional: search category that optimizes the search algorithm. 'general' for all web content (tutorials, docs, articles), 'news' for recent news articles, 'finance' for financial data and market information. Default: general.",
	}, -1)
	schema.AddRequired("query")

	return ToolDefinition{
		Type: "function",
		Function: &FunctionDetails{
			Name:        "web_search",
			Description: "Search the web for current information using an external search API. Returns up to 'max_results' web pages with titles, URLs, and content snippets. Use this to find recent news, facts, or information not in your training data or the user's documents.",
			Parameters:  schema,
		},
	}
}

// isWebSearchVariant returns true if the tool name is a web search provider variant.
// Web search variants (tavily_web_search, brave_web_search, etc.) should be treated
// as custom local tools with ExecutionSide: Local, not provider-side tools.
func isWebSearchVariant(name string) bool {
	switch name {
	case "tavily_web_search", "brave_web_search", "serper_web_search", "exa_web_search":
		return true
	default:
		return false
	}
}

// GetToolDefinitionByName returns the full tool definition for a given tool name.
// This is used to resolve minimal format {"name": "str_replace_based_edit_tool"} to full schemas.
// Returns nil if the tool name is not recognized as a custom tool.
//
// Provider-specific web search variants (tavily_web_search, brave_web_search, etc.)
// all map to the same web_search tool definition. The actual provider implementation
// is determined by the backend based on which variant was requested.
func GetToolDefinitionByName(name string) *ToolDefinition {
	switch name {
	// Unified text editor tool (view + edit combined)
	case "str_replace_based_edit_tool":
		def := getTextEditorToolDefinition()
		return &def

	// Legacy tool names - map to text editor for backward compatibility
	case "doc_view", "doc_edit":
		def := getTextEditorToolDefinition()
		return &def

	case "doc_tree":
		def := getTreeToolDefinition()
		return &def
	case "doc_search":
		def := getSearchToolDefinition()
		return &def

	// Provider-specific web search tools
	// All map to "web_search" schema, backend routes to appropriate provider
	case "tavily_web_search":
		def := getWebSearchToolDefinition()
		return &def
	case "brave_web_search":
		def := getWebSearchToolDefinition()
		return &def
	case "serper_web_search":
		def := getWebSearchToolDefinition()
		return &def
	case "exa_web_search":
		def := getWebSearchToolDefinition()
		return &def

	default:
		return nil
	}
}
