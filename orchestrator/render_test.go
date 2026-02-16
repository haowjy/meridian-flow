package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRenderTemplate(t *testing.T) {
	// Create a temp prompts directory with a test template
	dir := t.TempDir()
	templateContent := "Hello {{NAME}}, welcome to {{PLACE}}."
	if err := os.WriteFile(filepath.Join(dir, "test.md"), []byte(templateContent), 0644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name     string
		vars     map[string]string
		expected string
	}{
		{
			name:     "basic substitution",
			vars:     map[string]string{"NAME": "Alice", "PLACE": "Wonderland"},
			expected: "Hello Alice, welcome to Wonderland.",
		},
		{
			name:     "missing var left as-is",
			vars:     map[string]string{"NAME": "Bob"},
			expected: "Hello Bob, welcome to {{PLACE}}.",
		},
		{
			name:     "empty vars",
			vars:     map[string]string{},
			expected: templateContent,
		},
		{
			name:     "empty value substitution",
			vars:     map[string]string{"NAME": "", "PLACE": "Nowhere"},
			expected: "Hello , welcome to Nowhere.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := RenderTemplate(dir, "test.md", tt.vars)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result != tt.expected {
				t.Errorf("got %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestRenderTemplate_MultilineValue(t *testing.T) {
	dir := t.TempDir()
	template := "Tasks:\n{{BREADCRUMBS}}\nEnd."
	if err := os.WriteFile(filepath.Join(dir, "multi.md"), []byte(template), 0644); err != nil {
		t.Fatal(err)
	}

	result, err := RenderTemplate(dir, "multi.md", map[string]string{
		"BREADCRUMBS": "\n- file1.md\n- file2.md",
	})
	if err != nil {
		t.Fatal(err)
	}

	expected := "Tasks:\n\n- file1.md\n- file2.md\nEnd."
	if result != expected {
		t.Errorf("got %q, want %q", result, expected)
	}
}

func TestRenderTemplate_FileNotFound(t *testing.T) {
	dir := t.TempDir()
	_, err := RenderTemplate(dir, "nonexistent.md", nil)
	if err == nil {
		t.Fatal("expected error for missing template")
	}
}
