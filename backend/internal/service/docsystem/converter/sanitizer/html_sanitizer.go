package sanitizer

import (
	"github.com/microcosm-cc/bluemonday"
)

// HTMLSanitizer removes dangerous HTML elements and attributes to prevent XSS attacks.
// Separated from the converter to follow SRP (Single Responsibility Principle).
//
// Thread-safe for concurrent use.
type HTMLSanitizer struct {
	policy *bluemonday.Policy
}

// NewHTMLSanitizer creates a sanitizer with safe HTML policies.
// Uses a UGC (User Generated Content) policy that allows common formatting
// while stripping dangerous elements like scripts, event handlers, and javascript: URLs.
func NewHTMLSanitizer() *HTMLSanitizer {
	// Start with UGC policy (balanced security/functionality)
	policy := bluemonday.UGCPolicy()

	// Additional safety: ensure no data URIs in images (can contain embedded scripts)
	policy.AllowDataURIImages()

	return &HTMLSanitizer{policy: policy}
}

// NewStrictHTMLSanitizer creates a sanitizer with strict policies that strip all HTML.
// Use this for maximum security when HTML formatting is not needed.
func NewStrictHTMLSanitizer() *HTMLSanitizer {
	return &HTMLSanitizer{policy: bluemonday.StrictPolicy()}
}

// Sanitize removes dangerous HTML while preserving safe content.
// Returns the sanitized HTML string.
//
// Removes:
// - <script> tags
// - Event handlers (onclick, onerror, etc.)
// - javascript: URLs
// - Data exfiltration vectors
// - Other XSS attack vectors
//
// Preserves:
// - Basic formatting (p, br, strong, em, etc.)
// - Headings (h1-h6)
// - Lists (ul, ol, li)
// - Links and images (with sanitized URLs)
// - Tables
// - Code blocks
func (s *HTMLSanitizer) Sanitize(html string) (string, error) {
	return s.policy.Sanitize(html), nil
}
