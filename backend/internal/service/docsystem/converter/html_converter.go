package converter

import (
	"context"
	"fmt"

	md "github.com/JohannesKaufmann/html-to-markdown"

	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/service/docsystem/converter/sanitizer"
)

// htmlConverter converts HTML files to markdown.
// Implements a two-stage process:
// 1. Sanitize HTML to remove dangerous elements (XSS prevention)
// 2. Convert sanitized HTML to markdown
type htmlConverter struct {
	sanitizer *sanitizer.HTMLSanitizer
	converter *md.Converter
}

// NewHTMLConverter creates a new HTML to markdown converter.
// The converter automatically sanitizes HTML before conversion to prevent XSS attacks.
func NewHTMLConverter() docsysSvc.ContentConverter {
	return &htmlConverter{
		sanitizer: sanitizer.NewHTMLSanitizer(),
		converter: md.NewConverter("", true, nil),
	}
}

// Convert transforms HTML to markdown in two stages:
// 1. Sanitize: Remove <script>, event handlers, javascript: URLs, etc.
// 2. Convert: Transform HTML elements to markdown syntax
//
// Returns an error if sanitization or conversion fails.
func (c *htmlConverter) Convert(ctx context.Context, input []byte) (string, error) {
	// Stage 1: Sanitize HTML (remove dangerous tags/attributes)
	sanitized, err := c.sanitizer.Sanitize(string(input))
	if err != nil {
		return "", fmt.Errorf("failed to sanitize HTML: %w", err)
	}

	// Stage 2: Convert sanitized HTML to Markdown
	markdown, err := c.converter.ConvertString(sanitized)
	if err != nil {
		return "", fmt.Errorf("failed to convert HTML to markdown: %w", err)
	}

	return markdown, nil
}

// SupportedExtensions returns HTML file extensions.
func (c *htmlConverter) SupportedExtensions() []string {
	return []string{".html", ".htm"}
}

// Name returns the converter name for logging.
func (c *htmlConverter) Name() string {
	return "html"
}
