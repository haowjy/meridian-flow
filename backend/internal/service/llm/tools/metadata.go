package tools

// ToolMetadata describes a tool for system prompt generation.
// This enables OCP compliance - add new tools without modifying existing code.
// Each tool provides its own metadata, and the system prompt is generated
// from the registered tools rather than a separate hardcoded list.
type ToolMetadata struct {
	Name        string // Tool name (e.g., "doc_view")
	Description string // Human-readable description for system prompt (e.g., "Read any document or list folder contents")
	Guideline   string // Usage guideline for the LLM (optional, e.g., "Before suggesting edits, use doc_view to see current content")
}
