package streaming

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// ToolFieldConfig defines which fields to extract for a tool.
// OCP: Add new tools by adding entries to DefaultToolFieldConfigs, not modifying code.
type ToolFieldConfig struct {
	Fields []string // Field names to extract (e.g., ["path"], ["query"])
}

// DefaultToolFieldConfigs maps tool names to their extractable fields.
// Extend by adding entries, not modifying existing code.
var DefaultToolFieldConfigs = map[string]ToolFieldConfig{
	"doc_view":   {Fields: []string{"path"}},
	"doc_edit":   {Fields: []string{"path", "command"}},
	"doc_tree":   {Fields: []string{"folder", "depth"}},
	"doc_search": {Fields: []string{"query", "folder"}},
	"web_search": {Fields: []string{"query"}},
}

// ToolInputExtractor extracts fields from partial JSON during tool streaming.
// SRP: Only handles field extraction, no state/events/streaming logic.
type ToolInputExtractor struct {
	configs map[string]ToolFieldConfig
}

// NewToolInputExtractor creates an extractor with default configs.
func NewToolInputExtractor() *ToolInputExtractor {
	return &ToolInputExtractor{
		configs: DefaultToolFieldConfigs,
	}
}

// NewToolInputExtractorWithConfigs creates an extractor with custom configs.
// Useful for testing or adding custom tools.
func NewToolInputExtractorWithConfigs(configs map[string]ToolFieldConfig) *ToolInputExtractor {
	return &ToolInputExtractor{
		configs: configs,
	}
}

// Extract attempts to extract configured fields from partial JSON.
// Returns a map of field name -> value for fields that were successfully extracted.
// Fields that couldn't be extracted (incomplete JSON) are omitted from the result.
func (e *ToolInputExtractor) Extract(toolName, partialJSON string) map[string]interface{} {
	result := make(map[string]interface{})

	// Strategy 1: Try full JSON parse (works if JSON happens to be complete)
	if parsed := e.tryFullParse(partialJSON); parsed != nil {
		return parsed
	}

	// Strategy 2: Extract configured fields via regex
	config, ok := e.configs[toolName]
	if !ok {
		return result // Unknown tool, return empty
	}

	for _, field := range config.Fields {
		if value := extractStringField(partialJSON, field); value != "" {
			result[field] = value
		}
	}

	return result
}

// tryFullParse attempts to parse complete JSON and extract the input field.
// Tool use JSON structure: {"type":"tool_use","id":"...","name":"doc_view","input":{...}}
func (e *ToolInputExtractor) tryFullParse(jsonStr string) map[string]interface{} {
	// Try to parse as tool_use structure
	var toolUse struct {
		Input map[string]interface{} `json:"input"`
	}
	if err := json.Unmarshal([]byte(jsonStr), &toolUse); err == nil && toolUse.Input != nil {
		return toolUse.Input
	}

	// Try to parse as plain object (might be just the input part)
	var plain map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &plain); err == nil {
		// Check if this looks like tool input (has known fields like path, query, etc.)
		if _, hasPath := plain["path"]; hasPath {
			return plain
		}
		if _, hasQuery := plain["query"]; hasQuery {
			return plain
		}
	}

	return nil
}

// extractStringField extracts a complete string field using regex.
// Pattern: "fieldName":"value" - only matches complete string values.
// Returns empty string if field not found or value is incomplete.
func extractStringField(jsonStr, fieldName string) string {
	// Match: "fieldName"  :  "value"  (allowing whitespace)
	// The value must be a complete string (terminated by unescaped quote)
	pattern := fmt.Sprintf(`"%s"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"`, regexp.QuoteMeta(fieldName))
	re := regexp.MustCompile(pattern)
	if matches := re.FindStringSubmatch(jsonStr); len(matches) > 1 {
		return matches[1]
	}
	return ""
}
