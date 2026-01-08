package formatting

import "fmt"

// ErrorEncoder encodes a doc_edit error into a minimal string.
// Each encoder handles one error code type.
type ErrorEncoder func(data map[string]interface{}) string

// getErrorData extracts the error_data field from the result map.
func getErrorData(data map[string]interface{}) map[string]any {
	if errData, ok := data["error_data"].(map[string]any); ok {
		return errData
	}
	return nil
}

// errorEncoders maps error codes to their encoders.
// To add new error codes, simply add entries here (OCP).
// Encoders read structured data from error_data field.
var errorEncoders = map[string]ErrorEncoder{
	"NO_MATCH": func(_ map[string]interface{}) string {
		return "NO_MATCH"
	},
	"AMBIGUOUS_MATCH": func(data map[string]interface{}) string {
		if errData := getErrorData(data); errData != nil {
			if count, ok := errData["count"].(int); ok {
				return fmt.Sprintf("AMBIGUOUS:%d", count)
			}
		}
		return "AMBIGUOUS"
	},
	"DOC_NOT_FOUND": func(data map[string]interface{}) string {
		if errData := getErrorData(data); errData != nil {
			if path, ok := errData["path"].(string); ok {
				return fmt.Sprintf("NOT_FOUND:%s", path)
			}
		}
		return "NOT_FOUND"
	},
	"INVALID_LINE": func(data map[string]interface{}) string {
		if errData := getErrorData(data); errData != nil {
			max, _ := errData["max"].(int)
			return fmt.Sprintf("INVALID_LINE:0-%d", max)
		}
		return "INVALID_LINE"
	},
	"ALREADY_EXISTS": func(data map[string]interface{}) string {
		if errData := getErrorData(data); errData != nil {
			if path, ok := errData["path"].(string); ok {
				return fmt.Sprintf("ALREADY_EXISTS:%s", path)
			}
		}
		return "ALREADY_EXISTS"
	},
}

// DocEditFormatter transforms doc_edit error responses to minimal strings.
// Uses table-driven encoding for extensibility.
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

	// Check for error_code field to detect errors
	// Success responses don't have error_code, so they pass through unchanged
	errorCode, hasErrorCode := resultMap["error_code"].(string)
	if !hasErrorCode || errorCode == "" {
		// Success case - pass through unchanged (LLM can see the result data)
		return result
	}

	// Error case - look up encoder
	if encoder, exists := errorEncoders[errorCode]; exists {
		return encoder(resultMap)
	}

	// Unknown error code - return just the code
	return errorCode
}
