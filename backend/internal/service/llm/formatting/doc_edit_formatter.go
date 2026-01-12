package formatting

// DocEditFormatter transforms doc_edit error responses to minimal strings.
// Delegates to the shared tool error formatter for consistency across tools.
//
// Success responses: passed through unchanged (no formatting needed)
// Error responses: "NO_MATCH", "AMBIGUOUS:3", "NOT_FOUND:/path", etc.
//
// Errors are detected by presence of "error_code" field.
type DocEditFormatter struct{}

// Format transforms a doc_edit result for LLM consumption.
// Success results pass through unchanged; error results are compressed to minimal strings.
func (f *DocEditFormatter) Format(result interface{}) interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return result
	}

	// Success responses don't have error_code, so they pass through unchanged.
	if _, ok := resultMap["error_code"].(string); !ok {
		return result
	}

	if formatted, ok := TryFormatToolError(resultMap); ok {
		return formatted
	}

	// Fallback: return as-is (should not normally happen)
	return result
}
