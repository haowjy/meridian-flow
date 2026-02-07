package formatting

import "fmt"

// encodeToolError converts a structured tool error result map into a compact,
// recovery-friendly string for LLM consumption.
//
// This is intentionally shared across tools to avoid "formatter drift" where
// some tools become easy to recover from and others don't.
func encodeToolError(resultMap map[string]interface{}) string {
	errorCode, ok := resultMap["error_code"].(string)
	if !ok || errorCode == "" {
		return ""
	}

	if encoder, exists := toolErrorEncoders[errorCode]; exists {
		return encoder(resultMap)
	}

	// Unknown error code - return just the code
	return errorCode
}

// TryFormatToolError detects structured tool errors (maps with error_code) and returns
// a compact string representation. Returns (formatted, true) if formatted, else (nil, false).
func TryFormatToolError(result interface{}) (interface{}, bool) {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return nil, false
	}

	encoded := encodeToolError(resultMap)
	if encoded == "" {
		return nil, false
	}

	return encoded, true
}

// ToolErrorEncoder encodes a tool error result into a compact string.
// Encoders read structured data from the "error_data" field when present.
type ToolErrorEncoder func(resultMap map[string]interface{}) string

func getToolErrorData(data map[string]interface{}) map[string]any {
	if errData, ok := data["error_data"].(map[string]any); ok {
		return errData
	}
	return nil
}

var toolErrorEncoders = map[string]ToolErrorEncoder{
	// Generic errors (all tools)
	"MISSING_PARAM": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			if param, ok := errData["param"].(string); ok && param != "" {
				return fmt.Sprintf("MISSING_PARAM:%s", param)
			}
		}
		return "MISSING_PARAM"
	},
	"INVALID_INPUT": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			if param, ok := errData["param"].(string); ok && param != "" {
				return fmt.Sprintf("INVALID_INPUT:%s", param)
			}
			if value, exists := errData["value"]; exists {
				return fmt.Sprintf("INVALID_INPUT:%v", value)
			}
		}
		return "INVALID_INPUT"
	},
	"NOT_FOUND": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			if path, ok := errData["path"].(string); ok && path != "" {
				return fmt.Sprintf("NOT_FOUND:%s", path)
			}
		}
		return "NOT_FOUND"
	},

	// Document edit error codes (used by str_replace_based_edit_tool)
	"NO_MATCH": func(_ map[string]interface{}) string {
		return "NO_MATCH"
	},
	"AMBIGUOUS_MATCH": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			// Note: error_data may come through as float64 when JSON-decoded elsewhere.
			switch count := errData["count"].(type) {
			case int:
				return fmt.Sprintf("AMBIGUOUS:%d", count)
			case float64:
				return fmt.Sprintf("AMBIGUOUS:%d", int(count))
			}
		}
		return "AMBIGUOUS"
	},
	"DOC_NOT_FOUND": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			if path, ok := errData["path"].(string); ok && path != "" {
				// Historical encoding used by DocEditFormatter
				return fmt.Sprintf("NOT_FOUND:%s", path)
			}
		}
		return "NOT_FOUND"
	},
	"INVALID_LINE": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			switch max := errData["max"].(type) {
			case int:
				return fmt.Sprintf("INVALID_LINE:0-%d", max)
			case float64:
				return fmt.Sprintf("INVALID_LINE:0-%d", int(max))
			}
		}
		return "INVALID_LINE"
	},
	"ALREADY_EXISTS": func(data map[string]interface{}) string {
		if errData := getToolErrorData(data); errData != nil {
			if path, ok := errData["path"].(string); ok && path != "" {
				return fmt.Sprintf("ALREADY_EXISTS:%s", path)
			}
		}
		return "ALREADY_EXISTS"
	},
}

