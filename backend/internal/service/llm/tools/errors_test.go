package tools

import "testing"

func TestErrorResult_MissingParamMessageIncludesParam(t *testing.T) {
	result := ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "path"})

	msg, ok := result["message"].(string)
	if !ok {
		t.Fatalf("expected message to be string, got %T", result["message"])
	}
	if msg != "Missing required parameter: path" {
		t.Fatalf("message=%q, want %q", msg, "Missing required parameter: path")
	}
}

func TestErrorResult_MissingParamDoesNotOverrideCustomMessage(t *testing.T) {
	result := ErrorResult(ErrMissingParam, "append requires new_str parameter", map[string]any{"param": "new_str"})

	msg, ok := result["message"].(string)
	if !ok {
		t.Fatalf("expected message to be string, got %T", result["message"])
	}
	if msg != "append requires new_str parameter" {
		t.Fatalf("message=%q, want %q", msg, "append requires new_str parameter")
	}
}

