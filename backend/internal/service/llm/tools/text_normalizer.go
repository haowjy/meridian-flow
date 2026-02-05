package tools

import "regexp"

// TextNormalizer transforms input strings before matching.
// Implements the Strategy pattern for extensible text preprocessing.
//
// Follows the same pattern as ToolResultFormatter in formatting/formatter.go:
// - Single-method interface with minimal footprint (ISP)
// - Implementations are simple structs (LineNumberNormalizer, etc.)
// - Can be composed into a chain for multiple normalizations
//
// Use cases:
// - Stripping line number prefixes from view command output
// - Future: whitespace normalization, indentation handling, etc.
type TextNormalizer interface {
	// Name returns identifier for logging/messages
	Name() string
	// ShouldApply checks if this normalizer is relevant for the input
	ShouldApply(s string) bool
	// Normalize transforms the string
	Normalize(s string) string
}

// =============================================================================
// LINE NUMBER NORMALIZER
// =============================================================================

// lineNumberPattern matches line number prefixes like "1: ", "42: ", "999: "
// at the start of a line (multiline mode). These are added by the view command
// for LLM consumption but should not be part of the actual document content.
var lineNumberPattern = regexp.MustCompile(`(?m)^\d+: `)

// LineNumberNormalizer strips view command line prefixes (e.g., "1: ", "42: ").
// This allows str_replace to work when the LLM copies content from view output.
//
// Example:
//
//	"1: Hello\n2: World" -> "Hello\nWorld"
type LineNumberNormalizer struct{}

// Name returns the normalizer identifier for logging/messages.
func (n *LineNumberNormalizer) Name() string {
	return "line_numbers"
}

// ShouldApply checks if the string contains line number prefixes.
func (n *LineNumberNormalizer) ShouldApply(s string) bool {
	return lineNumberPattern.MatchString(s)
}

// Normalize strips line number prefixes from all lines.
func (n *LineNumberNormalizer) Normalize(s string) string {
	return lineNumberPattern.ReplaceAllString(s, "")
}

// =============================================================================
// NORMALIZER CHAIN HELPERS
// =============================================================================

// matchResult contains the result of a successful match after normalization.
type matchResult struct {
	// matchedOld is the old_str as it exists in the document (possibly normalized)
	matchedOld string
	// normalizedNew is the new_str after applying the same normalization
	normalizedNew string
	// appliedNorm is the name of the normalizer that was applied (empty for exact match)
	appliedNorm string
}

// tryMatchWithNormalizers attempts to find oldStr in base content.
// First tries exact match, then applies normalizers in order.
//
// Returns:
// - matchResult if a match was found (exact or normalized)
// - nil with error message if no match found
func tryMatchWithNormalizers(base, oldStr, newStr string, normalizers []TextNormalizer) (*matchResult, string) {
	// Try exact match first (most common case)
	if containsExact(base, oldStr) {
		return &matchResult{
			matchedOld:    oldStr,
			normalizedNew: newStr,
			appliedNorm:   "",
		}, ""
	}

	// Try each normalizer in order
	var attemptedNormalizers []string
	for _, norm := range normalizers {
		if !norm.ShouldApply(oldStr) {
			continue
		}

		attemptedNormalizers = append(attemptedNormalizers, norm.Name())
		normOld := norm.Normalize(oldStr)
		normNew := norm.Normalize(newStr)

		if containsExact(base, normOld) {
			return &matchResult{
				matchedOld:    normOld,
				normalizedNew: normNew,
				appliedNorm:   norm.Name(),
			}, ""
		}
	}

	// Build helpful error message
	if len(attemptedNormalizers) > 0 {
		return nil, "Text not found in document. Attempted normalizations: " +
			joinStrings(attemptedNormalizers, ", ") +
			". Use view command to see current content and try again."
	}

	return nil, "Text not found in document. Use view command to see current content and try again."
}

// containsExact checks if base contains the exact substring s.
// Wrapper for strings.Contains to make intent clear.
func containsExact(base, s string) bool {
	return len(s) > 0 && len(base) >= len(s) && indexOfSubstring(base, s) >= 0
}

// indexOfSubstring returns the index of s in base, or -1 if not found.
// Uses standard library's efficient string search.
func indexOfSubstring(base, s string) int {
	for i := 0; i <= len(base)-len(s); i++ {
		if base[i:i+len(s)] == s {
			return i
		}
	}
	return -1
}

// joinStrings joins strings with a separator.
func joinStrings(strs []string, sep string) string {
	if len(strs) == 0 {
		return ""
	}
	if len(strs) == 1 {
		return strs[0]
	}

	// Calculate total length for efficient allocation
	totalLen := len(strs[0])
	for _, s := range strs[1:] {
		totalLen += len(sep) + len(s)
	}

	// Build result with pre-allocated buffer
	result := make([]byte, 0, totalLen)
	result = append(result, strs[0]...)
	for _, s := range strs[1:] {
		result = append(result, sep...)
		result = append(result, s...)
	}
	return string(result)
}

// =============================================================================
// DEFAULT NORMALIZERS
// =============================================================================

// DefaultNormalizers returns the standard set of normalizers used by TextEditorTool.
// Order matters: normalizers are tried in sequence until one matches.
func DefaultNormalizers() []TextNormalizer {
	return []TextNormalizer{
		&LineNumberNormalizer{},
		// Future normalizers can be added here:
		// &WhitespaceNormalizer{},
		// &IndentationNormalizer{},
	}
}
