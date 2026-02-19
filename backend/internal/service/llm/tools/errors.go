package tools

import "fmt"

// Tool Error Handling
//
// This file defines error codes and helpers for TOOL-LEVEL errors (execution layer).
// These are distinct from LIBRARY-LEVEL errors (streaming/decode layer) in meridian-llm-go:
//
//   - Library errors: Malformed tool JSON from provider -> `_malformed: {raw, error}`
//   - Tool errors: Valid tool call that failed execution -> `ErrorResult(code, message, data)`
//
// The separation is intentional: library handles "couldn't parse" while tools handle
// "understood but couldn't execute".

// Error codes for recoverable tool errors.
// Use these constants when calling ErrorResult().
const (
	// Generic error codes (all tools)
	ErrMissingParam = "MISSING_PARAM"
	ErrNotFound     = "NOT_FOUND"
	ErrInvalidInput = "INVALID_INPUT"

	// Document-specific error codes (text editor tool)
	// These provide more context for LLM recovery strategies.
	ErrDocNotFound     = "DOC_NOT_FOUND"
	ErrDocAlreadyExists = "ALREADY_EXISTS"
	ErrNoMatch         = "NO_MATCH"
	ErrAmbiguousMatch  = "AMBIGUOUS_MATCH"
	ErrInvalidLine     = "INVALID_LINE"
)

// ErrorResult creates a recoverable error result.
// Use for errors the LLM can act on (retry with different input).
// System errors (DB failures, network errors) should use return nil, err.
//
// Example:
//
//	return ErrorResult(ErrNotFound, "Document not found", map[string]any{"path": path}), nil
func ErrorResult(code, message string, data map[string]any) map[string]interface{} {
	// Make missing-param errors self-healing for LLMs even if error_data is lost later.
	// Many tools use the generic message "Missing required parameter"; enrich it with the param.
	if code == ErrMissingParam && message == "Missing required parameter" && data != nil {
		if param, ok := data["param"].(string); ok && param != "" {
			message = fmt.Sprintf("Missing required parameter: %s", param)
		}
	}

	result := map[string]interface{}{
		"success":    false,
		"error_code": code,
		"message":    message,
	}
	if data != nil {
		result["error_data"] = data
	}
	return result
}
