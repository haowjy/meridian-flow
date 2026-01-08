package formatting

import (
	"reflect"
	"testing"
)

func TestDocEditFormatter_Format(t *testing.T) {
	formatter := &DocEditFormatter{}

	tests := []struct {
		name     string
		input    interface{}
		expected interface{}
	}{
		{
			name: "success passes through unchanged",
			input: map[string]interface{}{
				"path":    "/chapters/ch1.md",
				"message": "Suggested text replacement",
			},
			expected: map[string]interface{}{
				"path":    "/chapters/ch1.md",
				"message": "Suggested text replacement",
			},
		},
		{
			name: "NO_MATCH returns NO_MATCH",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "NO_MATCH",
				"message":    "Text not found in document.",
			},
			expected: "NO_MATCH",
		},
		{
			name: "AMBIGUOUS_MATCH returns count from error_data",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "AMBIGUOUS_MATCH",
				"message":    "Multiple matches found",
				"error_data": map[string]any{"count": 3},
			},
			expected: "AMBIGUOUS:3",
		},
		{
			name: "AMBIGUOUS_MATCH without error_data returns fallback",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "AMBIGUOUS_MATCH",
				"message":    "Multiple matches found",
			},
			expected: "AMBIGUOUS",
		},
		{
			name: "DOC_NOT_FOUND includes path from error_data",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "DOC_NOT_FOUND",
				"message":    "Document not found",
				"error_data": map[string]any{"path": "/chapters/chapter1.md"},
			},
			expected: "NOT_FOUND:/chapters/chapter1.md",
		},
		{
			name: "DOC_NOT_FOUND without error_data returns fallback",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "DOC_NOT_FOUND",
				"message":    "Document not found",
			},
			expected: "NOT_FOUND",
		},
		{
			name: "INVALID_LINE includes range from error_data",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "INVALID_LINE",
				"message":    "Line out of range",
				"error_data": map[string]any{"line": 50, "max": 42},
			},
			expected: "INVALID_LINE:0-42",
		},
		{
			name: "INVALID_LINE without error_data returns fallback",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "INVALID_LINE",
				"message":    "Line out of range",
			},
			expected: "INVALID_LINE",
		},
		{
			name: "ALREADY_EXISTS includes path from error_data",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "ALREADY_EXISTS",
				"message":    "Document already exists",
				"error_data": map[string]any{"path": "/chapters/new.md"},
			},
			expected: "ALREADY_EXISTS:/chapters/new.md",
		},
		{
			name: "ALREADY_EXISTS without error_data returns fallback",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "ALREADY_EXISTS",
				"message":    "Document already exists",
			},
			expected: "ALREADY_EXISTS",
		},
		{
			name:     "non-map input passes through",
			input:    "some string",
			expected: "some string",
		},
		{
			name: "unknown error code returns code",
			input: map[string]interface{}{
				"success":    false,
				"error_code": "UNKNOWN_ERROR",
				"message":    "Something went wrong",
			},
			expected: "UNKNOWN_ERROR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatter.Format(tt.input)
			if !reflect.DeepEqual(result, tt.expected) {
				t.Errorf("Format() = %v, want %v", result, tt.expected)
			}
		})
	}
}

func TestGetErrorData(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]interface{}
		expected map[string]any
	}{
		{
			name: "extracts error_data when present",
			input: map[string]interface{}{
				"error_data": map[string]any{"path": "/test"},
			},
			expected: map[string]any{"path": "/test"},
		},
		{
			name:     "returns nil when error_data missing",
			input:    map[string]interface{}{},
			expected: nil,
		},
		{
			name: "returns nil when error_data is wrong type",
			input: map[string]interface{}{
				"error_data": "not a map",
			},
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := getErrorData(tt.input)
			if tt.expected == nil {
				if result != nil {
					t.Errorf("getErrorData() = %v, want nil", result)
				}
			} else {
				if result == nil {
					t.Errorf("getErrorData() = nil, want %v", tt.expected)
				}
			}
		})
	}
}
