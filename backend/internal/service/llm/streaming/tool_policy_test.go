package streaming

import (
	"reflect"
	"testing"

	domaindocsys "meridian/internal/domain/docsystem"
)

func TestParseDisabledTools(t *testing.T) {
	t.Run("nil preferences", func(t *testing.T) {
		got := parseDisabledTools(nil)
		if len(got) != 0 {
			t.Fatalf("expected empty set, got %v", got)
		}
	})

	t.Run("string slice", func(t *testing.T) {
		got := parseDisabledTools(domaindocsys.JSONMap{
			"disabled_tools": []string{"str_replace_based_edit_tool", "tavily_web_search"},
		})
		if !got["str_replace_based_edit_tool"] || !got["tavily_web_search"] {
			t.Fatalf("expected disabled tools to be present, got %v", got)
		}
	})

	t.Run("interface slice", func(t *testing.T) {
		got := parseDisabledTools(domaindocsys.JSONMap{
			"disabled_tools": []interface{}{"doc_search", "tavily_web_search"},
		})
		if !got["doc_search"] || !got["tavily_web_search"] {
			t.Fatalf("expected disabled tools to be present, got %v", got)
		}
	})
}

func TestResolveServerToolNames(t *testing.T) {
	t.Run("disabled str_replace_based_edit_tool with web search", func(t *testing.T) {
		disabled := map[string]bool{
			"str_replace_based_edit_tool": true,
		}
		got := resolveServerToolNames(true, disabled)
		want := []string{"doc_search", "skill_invoke", "skill_list", "tavily_web_search"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("resolveServerToolNames mismatch\nwant=%v\ngot =%v", want, got)
		}
	})

	t.Run("no disabled tools, no web search", func(t *testing.T) {
		got := resolveServerToolNames(false, map[string]bool{})
		want := []string{"str_replace_based_edit_tool", "doc_search", "skill_invoke", "skill_list"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("resolveServerToolNames mismatch\nwant=%v\ngot =%v", want, got)
		}
	})
}

func TestToolNamesToRequestParamsTools(t *testing.T) {
	tools, err := toolNamesToRequestParamsTools([]string{"str_replace_based_edit_tool", "tavily_web_search"})
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
	if first["name"] != "str_replace_based_edit_tool" {
		t.Fatalf("expected first tool name str_replace_based_edit_tool, got %v", first["name"])
	}
}
