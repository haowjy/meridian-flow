package streaming

import (
	"reflect"
	"testing"

	"meridian/internal/domain/models/docsystem"
)

func TestParseDisabledTools(t *testing.T) {
	t.Run("nil preferences", func(t *testing.T) {
		got := parseDisabledTools(nil)
		if len(got) != 0 {
			t.Fatalf("expected empty set, got %v", got)
		}
	})

	t.Run("string slice", func(t *testing.T) {
		got := parseDisabledTools(docsystem.JSONMap{
			"disabled_tools": []string{"doc_edit", "tavily_web_search"},
		})
		if !got["doc_edit"] || !got["tavily_web_search"] {
			t.Fatalf("expected disabled tools to be present, got %v", got)
		}
	})

	t.Run("interface slice", func(t *testing.T) {
		got := parseDisabledTools(docsystem.JSONMap{
			"disabled_tools": []interface{}{"doc_tree", "doc_search"},
		})
		if !got["doc_tree"] || !got["doc_search"] {
			t.Fatalf("expected disabled tools to be present, got %v", got)
		}
	})
}

func TestResolveServerToolNames(t *testing.T) {
	disabled := map[string]bool{
		"doc_edit": true,
	}
	got := resolveServerToolNames(true, disabled)
	want := []string{"doc_view", "doc_search", "doc_tree", "tavily_web_search"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolveServerToolNames mismatch\nwant=%v\ngot =%v", want, got)
	}
}

func TestToolNamesToRequestParamsTools(t *testing.T) {
	tools, err := toolNamesToRequestParamsTools([]string{"doc_view", "tavily_web_search"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}

	first, ok := tools[0].(map[string]interface{})
	if !ok {
		t.Fatalf("expected map tool definition, got %T", tools[0])
	}
	if first["name"] != "doc_view" {
		t.Fatalf("expected first tool name doc_view, got %v", first["name"])
	}
}
