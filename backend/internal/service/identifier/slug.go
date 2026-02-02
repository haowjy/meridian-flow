// Package identifier provides utilities for URL-friendly identifiers (slugs)
// and identifier resolution (UUID vs slug detection).
package identifier

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var (
	// Matches any character that's not alphanumeric, space, or hyphen
	nonSlugChars = regexp.MustCompile(`[^a-zA-Z0-9\s-]`)
	// Matches one or more whitespace characters
	whitespace = regexp.MustCompile(`\s+`)
	// Matches one or more consecutive hyphens
	multipleHyphens = regexp.MustCompile(`-+`)
)

// GenerateSlug converts a name to a URL-friendly slug.
// Example: "My Novel Chapter 1" → "my-novel-chapter-1"
//
// Transformations applied:
// 1. Normalize unicode (NFD) and remove diacritics (é → e)
// 2. Trim whitespace
// 3. Convert to lowercase
// 4. Remove special characters (keep alphanumeric, spaces, hyphens)
// 5. Replace spaces with hyphens
// 6. Collapse multiple consecutive hyphens
// 7. Trim leading/trailing hyphens
func GenerateSlug(name string) string {
	// Normalize unicode and remove diacritics (accents)
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	normalized, _, _ := transform.String(t, name)

	// Trim and lowercase
	slug := strings.ToLower(strings.TrimSpace(normalized))

	// Remove special characters (keep alphanumeric, spaces, hyphens)
	slug = nonSlugChars.ReplaceAllString(slug, "")

	// Replace spaces with hyphens
	slug = whitespace.ReplaceAllString(slug, "-")

	// Collapse multiple hyphens
	slug = multipleHyphens.ReplaceAllString(slug, "-")

	// Trim leading/trailing hyphens
	slug = strings.Trim(slug, "-")

	return slug
}

// EnsureUniqueSlug ensures the slug is unique by appending a numeric suffix
// if the base slug already exists.
//
// Example: If "chapter-1" exists, returns "chapter-1-2", then "chapter-1-3", etc.
//
// The exists function should return true if the slug is already in use.
// For updates, make sure to exclude the current entity from the exists check.
func EnsureUniqueSlug(baseSlug string, exists func(slug string) bool) string {
	if baseSlug == "" {
		baseSlug = "untitled"
	}

	slug := baseSlug
	suffix := 1

	for exists(slug) {
		suffix++
		slug = baseSlug + "-" + itoa(suffix)
	}

	return slug
}

// itoa converts an integer to a string without importing strconv
func itoa(n int) string {
	if n == 0 {
		return "0"
	}

	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

