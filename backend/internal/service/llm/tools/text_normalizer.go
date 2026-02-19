package tools

import (
	"regexp"
	"strings"
)

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
// LINE ENDING NORMALIZER
// =============================================================================

// LineEndingNormalizer normalizes Windows/Mac line endings to Unix style (\n).
// This prevents multiline matching failures when copied text contains CRLF.
//
// Example:
//
//	"Hello\r\nWorld\r\n" -> "Hello\nWorld\n"
type LineEndingNormalizer struct{}

// Name returns the normalizer identifier for logging/messages.
func (n *LineEndingNormalizer) Name() string {
	return "line_endings"
}

// ShouldApply checks if the string contains non-Unix line endings.
func (n *LineEndingNormalizer) ShouldApply(s string) bool {
	return strings.Contains(s, "\r")
}

// Normalize converts all CRLF/CR line endings to LF.
func (n *LineEndingNormalizer) Normalize(s string) string {
	normalized := strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(normalized, "\r", "\n")
}

// =============================================================================
// TRAILING WHITESPACE NORMALIZER
// =============================================================================

// TrailingWhitespaceNormalizer strips trailing horizontal whitespace from each line
// and ignores terminal newline differences.
//
// This makes str_replace more tolerant when an LLM copies multiline snippets with
// slightly different trailing spaces/newline at EOF.
//
// Example:
//
//	"foo  \nbar\t\n" -> "foo\nbar"
type TrailingWhitespaceNormalizer struct{}

// Name returns the normalizer identifier for logging/messages.
func (n *TrailingWhitespaceNormalizer) Name() string {
	return "trailing_whitespace"
}

// ShouldApply checks if there are tabs/spaces before newline or at end of content,
// or if the string ends with a newline that may differ from document EOF formatting.
func (n *TrailingWhitespaceNormalizer) ShouldApply(s string) bool {
	return strings.Contains(s, " \n") ||
		strings.Contains(s, "\t\n") ||
		strings.HasSuffix(s, " ") ||
		strings.HasSuffix(s, "\t") ||
		strings.HasSuffix(s, "\n")
}

// Normalize strips right-side tabs/spaces per line and trims terminal newlines.
func (n *TrailingWhitespaceNormalizer) Normalize(s string) string {
	if s == "" {
		return s
	}

	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
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

	// Try cumulative normalization chain (handles combinations like:
	// line numbers + trailing whitespace + CRLF differences).
	cumulativeOld := oldStr
	cumulativeNew := newStr
	var appliedChain []string
	for _, norm := range normalizers {
		if !norm.ShouldApply(cumulativeOld) {
			continue
		}
		appliedChain = append(appliedChain, norm.Name())
		cumulativeOld = norm.Normalize(cumulativeOld)
		cumulativeNew = norm.Normalize(cumulativeNew)
	}
	if len(appliedChain) > 0 {
		attemptedNormalizers = append(attemptedNormalizers, "chain("+joinStrings(appliedChain, "->")+")")
		if containsExact(base, cumulativeOld) {
			return &matchResult{
				matchedOld:    cumulativeOld,
				normalizedNew: cumulativeNew,
				appliedNorm:   "chain(" + joinStrings(appliedChain, "->") + ")",
			}, ""
		}
	}

	// Final fallback for multiline edits: tolerant per-line whitespace matching.
	// This handles cases where copied snippets differ in leading/trailing spaces,
	// while still requiring contiguous line structure.
	if strings.Contains(oldStr, "\n") {
		attemptedNormalizers = append(attemptedNormalizers, "flex_whitespace")
		if matchedOld, normalizedNew, ok, ambiguousCount := tryFlexibleWhitespaceMatch(base, oldStr, newStr); ok {
			return &matchResult{
				matchedOld:    matchedOld,
				normalizedNew: normalizedNew,
				appliedNorm:   "flex_whitespace",
			}, ""
		} else if ambiguousCount > 1 {
			return nil, "AMBIGUOUS_MATCH:flex_whitespace:" + intToString(ambiguousCount)
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

// tryFlexibleWhitespaceMatch attempts a multiline contiguous match where each line
// tolerates different leading/trailing horizontal whitespace.
//
// Returns:
// - matchedOld: exact substring from base to replace
// - normalizedNew: new text with line numbers removed and line endings normalized
// - ok: whether a unique match was found
// - ambiguousCount: number of matches found when >1
func tryFlexibleWhitespaceMatch(base, oldStr, newStr string) (matchedOld, normalizedNew string, ok bool, ambiguousCount int) {
	// Pre-normalize LLM-copied snippets for common artifacts.
	normalizedOld := normalizeForFlexibleWhitespace(oldStr)
	normalizedNew = normalizeForFlexibleWhitespace(newStr)

	lines := strings.Split(normalizedOld, "\n")
	if len(lines) == 0 {
		return "", "", false, 0
	}

	// Build regex that allows flexible leading/trailing spaces on each line.
	var pattern strings.Builder
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		pattern.WriteString(`[ \t]*`)
		pattern.WriteString(regexp.QuoteMeta(trimmed))
		pattern.WriteString(`[ \t]*`)
		if i < len(lines)-1 {
			pattern.WriteString(`\n`)
		}
	}

	re, err := regexp.Compile(pattern.String())
	if err != nil {
		return "", "", false, 0
	}

	matches := re.FindAllStringIndex(base, -1)
	if len(matches) == 0 {
		return "", "", false, 0
	}
	if len(matches) > 1 {
		return "", "", false, len(matches)
	}

	start, end := matches[0][0], matches[0][1]
	return base[start:end], normalizedNew, true, 1
}

// normalizeForFlexibleWhitespace removes line-number prefixes and normalizes line endings.
// It also trims terminal newlines to avoid EOF mismatch from copied snippets.
func normalizeForFlexibleWhitespace(s string) string {
	if s == "" {
		return s
	}
	s = (&LineNumberNormalizer{}).Normalize(s)
	s = (&LineEndingNormalizer{}).Normalize(s)
	return strings.TrimRight(s, "\n")
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

// intToString converts a non-negative integer to decimal string.
func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	// int in Go is signed; this helper is only used for non-negative values.
	if n < 0 {
		n = -n
	}
	var digits [20]byte
	i := len(digits)
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[i:])
}

// =============================================================================
// DEFAULT NORMALIZERS
// =============================================================================

// DefaultNormalizers returns the standard set of normalizers used by TextEditorTool.
// Order matters: normalizers are tried in sequence until one matches.
func DefaultNormalizers() []TextNormalizer {
	return []TextNormalizer{
		&LineNumberNormalizer{},
		&LineEndingNormalizer{},
		&TrailingWhitespaceNormalizer{},
	}
}
