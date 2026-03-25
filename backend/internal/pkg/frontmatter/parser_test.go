package frontmatter_test

import (
	"testing"

	"meridian/internal/pkg/frontmatter"
)

// ---- helpers ---------------------------------------------------------------

func mustParse(t *testing.T, content string) (map[string]interface{}, string) {
	t.Helper()
	fm, body, err := frontmatter.Parse(content)
	if err != nil {
		t.Fatalf("Parse() unexpected error: %v", err)
	}
	return fm, body
}

// ---- Parse tests -----------------------------------------------------------

func TestParse_ValidYAML(t *testing.T) {
	content := "---\nname: story-bible\ndescription: Canon lookup\nenabled: true\n---\n\n# Instructions\nsome body\n"

	fm, body := mustParse(t, content)

	if fm["name"] != "story-bible" {
		t.Errorf("name = %q, want %q", fm["name"], "story-bible")
	}
	if fm["description"] != "Canon lookup" {
		t.Errorf("description = %q, want %q", fm["description"], "Canon lookup")
	}
	if fm["enabled"] != true {
		t.Errorf("enabled = %v, want true", fm["enabled"])
	}

	const wantBody = "\n# Instructions\nsome body\n"
	if body != wantBody {
		t.Errorf("body = %q, want %q", body, wantBody)
	}
}

func TestParse_MissingFrontmatter(t *testing.T) {
	content := "# No frontmatter here\nsome content\n"

	_, _, err := frontmatter.Parse(content)
	if err == nil {
		t.Fatal("Parse() expected error for missing frontmatter, got nil")
	}
}

func TestParse_NoOpeningDelimiter_EmptyContent(t *testing.T) {
	_, _, err := frontmatter.Parse("")
	if err == nil {
		t.Fatal("Parse() expected error for empty content, got nil")
	}
}

func TestParse_MissingClosingDelimiter(t *testing.T) {
	content := "---\nname: test\n# no closing delimiter\n"

	_, _, err := frontmatter.Parse(content)
	if err == nil {
		t.Fatal("Parse() expected error for missing closing delimiter, got nil")
	}
}

func TestParse_EmptyBodyAfterFrontmatter(t *testing.T) {
	// Body is empty — this is explicitly allowed.
	content := "---\nname: test\ndescription: desc\n---\n"

	fm, body := mustParse(t, content)

	if fm["name"] != "test" {
		t.Errorf("name = %q, want %q", fm["name"], "test")
	}
	if body != "" {
		t.Errorf("body = %q, want empty string", body)
	}
}

func TestParse_EmptyBodyNoTrailingNewline(t *testing.T) {
	// Closing delimiter with no newline at all after it.
	content := "---\nname: test\n---"

	fm, body := mustParse(t, content)

	if fm["name"] != "test" {
		t.Errorf("name = %q, want %q", fm["name"], "test")
	}
	if body != "" {
		t.Errorf("body = %q, want empty string", body)
	}
}

func TestParse_UnknownFieldsAllowed(t *testing.T) {
	// Unknown YAML keys must not cause an error (forward compatibility).
	content := "---\nname: test\nfuture_field: some value\nanother_unknown: 42\n---\nbody\n"

	fm, body := mustParse(t, content)

	if fm["name"] != "test" {
		t.Errorf("name = %q, want %q", fm["name"], "test")
	}
	if fm["future_field"] != "some value" {
		t.Errorf("future_field = %v, want %q", fm["future_field"], "some value")
	}
	if body != "body\n" {
		t.Errorf("body = %q, want %q", body, "body\n")
	}
}

func TestParse_InvalidYAML(t *testing.T) {
	// Unclosed flow sequence is a genuine YAML syntax error.
	content := "---\nkey: [unclosed\n---\nbody\n"

	_, _, err := frontmatter.Parse(content)
	if err == nil {
		t.Fatal("Parse() expected error for invalid YAML, got nil")
	}
}

func TestParse_ClosingDelimiterMustBeExact(t *testing.T) {
	// A line beginning with '---' but followed by more text (e.g. '--- note')
	// must NOT be treated as the closing delimiter.  The parser must keep
	// searching and return an error when no exact '---' line is present.
	content := "---\nname: test\n--- not a delimiter\nmore yaml\n"

	_, _, err := frontmatter.Parse(content)
	if err == nil {
		t.Fatal("Parse() expected error: '--- not a delimiter' should not close the frontmatter block")
	}
}

func TestParse_WindowsLineEndings(t *testing.T) {
	// The parser normalises \r\n → \n throughout so that delimiter detection
	// works regardless of the editor that wrote the file.  Body line endings
	// are also normalised as a consequence.
	content := "---\r\nname: test\r\n---\r\nbody\r\n"

	fm, body := mustParse(t, content)

	if fm["name"] != "test" {
		t.Errorf("name = %q, want %q", fm["name"], "test")
	}
	// \r\n normalised to \n in body
	if body != "body\n" {
		t.Errorf("body = %q, want %q", body, "body\n")
	}
}

// ---- ParseInto tests -------------------------------------------------------

type skillFrontmatter struct {
	Name        string  `yaml:"name"`
	Description string  `yaml:"description"`
	Enabled     bool    `yaml:"enabled"`
	Position    *int    `yaml:"position"`
	Version     *string `yaml:"version"`
}

func TestParseInto_ValidTypedStruct(t *testing.T) {
	content := "---\nname: prose-analysis\ndescription: Analyse prose quality\nenabled: true\nposition: 5\nversion: \"1.2.0\"\n---\n\n# Skill body\n"

	sk, body, err := frontmatter.ParseInto[skillFrontmatter](content)
	if err != nil {
		t.Fatalf("ParseInto() unexpected error: %v", err)
	}

	if sk.Name != "prose-analysis" {
		t.Errorf("Name = %q, want %q", sk.Name, "prose-analysis")
	}
	if sk.Description != "Analyse prose quality" {
		t.Errorf("Description = %q, want prose-analysis", sk.Description)
	}
	if !sk.Enabled {
		t.Errorf("Enabled = false, want true")
	}
	if sk.Position == nil || *sk.Position != 5 {
		t.Errorf("Position = %v, want 5", sk.Position)
	}
	if sk.Version == nil || *sk.Version != "1.2.0" {
		t.Errorf("Version = %v, want \"1.2.0\"", sk.Version)
	}

	const wantBody = "\n# Skill body\n"
	if body != wantBody {
		t.Errorf("body = %q, want %q", body, wantBody)
	}
}

func TestParseInto_UnknownFieldsIgnored(t *testing.T) {
	// The struct only knows about "name"; extra fields must not cause errors.
	content := "---\nname: coach\nfuture_field: ignored\nanother: 99\n---\nbody\n"

	type minimal struct {
		Name string `yaml:"name"`
	}

	m, _, err := frontmatter.ParseInto[minimal](content)
	if err != nil {
		t.Fatalf("ParseInto() unexpected error: %v", err)
	}
	if m.Name != "coach" {
		t.Errorf("Name = %q, want %q", m.Name, "coach")
	}
}

func TestParseInto_MissingFrontmatter(t *testing.T) {
	_, _, err := frontmatter.ParseInto[skillFrontmatter]("no frontmatter")
	if err == nil {
		t.Fatal("ParseInto() expected error for missing frontmatter, got nil")
	}
}

func TestParseInto_EmptyBody(t *testing.T) {
	content := "---\nname: test\n---\n"

	sk, body, err := frontmatter.ParseInto[skillFrontmatter](content)
	if err != nil {
		t.Fatalf("ParseInto() unexpected error: %v", err)
	}
	if sk.Name != "test" {
		t.Errorf("Name = %q, want %q", sk.Name, "test")
	}
	if body != "" {
		t.Errorf("body = %q, want empty string", body)
	}
}
