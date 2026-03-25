// Package frontmatter provides a pure-utility YAML frontmatter parser.
// It has no domain imports and carries no business logic — callers own
// validation of the extracted data.
package frontmatter

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

const delimiter = "---"

// Parse extracts YAML frontmatter and the remaining body from content.
//
// The content must begin with a line containing exactly "---"; the block
// ends at the next line containing exactly "---". Everything after that
// closing delimiter is returned as body (leading newline stripped).
//
// Returns an error when:
//   - no opening delimiter is present
//   - no closing delimiter is found after the opening one
//   - the YAML between the delimiters is syntactically invalid
//
// Unknown YAML fields are allowed and silently ignored so callers remain
// forward-compatible with external bundles carrying extra metadata.
//
// A nil map is returned when the frontmatter block contains no YAML content.
func Parse(content string) (map[string]interface{}, string, error) {
	raw, body, err := split(content)
	if err != nil {
		return nil, "", err
	}

	var result map[string]interface{}
	if err := yaml.Unmarshal([]byte(raw), &result); err != nil {
		return nil, "", fmt.Errorf("frontmatter: invalid YAML: %w", err)
	}

	return result, body, nil
}

// ParseInto unmarshals the YAML frontmatter into a typed struct T and
// returns the remaining body. Unknown YAML fields are ignored (forward
// compatibility). The struct may use `yaml:"..."` tags to control mapping.
func ParseInto[T any](content string) (T, string, error) {
	var zero T

	raw, body, err := split(content)
	if err != nil {
		return zero, "", err
	}

	var result T
	if err := yaml.Unmarshal([]byte(raw), &result); err != nil {
		return zero, "", fmt.Errorf("frontmatter: invalid YAML: %w", err)
	}

	return result, body, nil
}

// split separates the raw YAML text from the body without parsing the YAML.
// This is the single place that understands delimiter mechanics.
func split(content string) (rawYAML, body string, err error) {
	// Normalise Windows line endings so index arithmetic is consistent.
	content = strings.ReplaceAll(content, "\r\n", "\n")

	// Opening delimiter must be the very first line.
	if !strings.HasPrefix(content, delimiter+"\n") {
		return "", "", fmt.Errorf("frontmatter: no opening delimiter found")
	}

	// Advance past the opening "---\n".
	rest := content[len(delimiter)+1:]

	// Locate the closing delimiter — must be an exact '---' line.
	// Match '\n---\n' (mid-content) or '\n---' at end-of-string.
	// A line like '--- note' must NOT match; we advance past such false
	// positives and keep searching.
	closeIdx := -1
	searchFrom := 0
	for searchFrom < len(rest) {
		idx := strings.Index(rest[searchFrom:], "\n"+delimiter)
		if idx < 0 {
			break
		}
		abs := searchFrom + idx
		afterDelim := rest[abs+1+len(delimiter):]
		if afterDelim == "" || strings.HasPrefix(afterDelim, "\n") {
			closeIdx = abs
			break
		}
		// The '---' was part of a longer token (e.g. '--- note'); skip it.
		searchFrom = abs + 1
	}
	if closeIdx < 0 {
		return "", "", fmt.Errorf("frontmatter: no closing delimiter found")
	}

	rawYAML = rest[:closeIdx]

	// Skip past the closing "\n---".
	after := rest[closeIdx+1+len(delimiter):]

	// Strip the single newline that conventionally follows the closing "---".
	// An empty or whitespace-only body is allowed.
	if strings.HasPrefix(after, "\n") {
		after = after[1:]
	}

	return rawYAML, after, nil
}
