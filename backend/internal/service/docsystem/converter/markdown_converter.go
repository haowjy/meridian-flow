package converter

import (
	"context"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// markdownConverter is a passthrough converter for markdown files.
// Since markdown is the native storage format, no conversion is needed.
type markdownConverter struct{}

// NewMarkdownConverter creates a new markdown passthrough converter.
func NewMarkdownConverter() docsysSvc.ContentConverter {
	return &markdownConverter{}
}

// Convert returns the input unchanged (passthrough).
func (c *markdownConverter) Convert(ctx context.Context, input []byte) (string, error) {
	return string(input), nil
}

// SupportedExtensions returns markdown file extensions.
func (c *markdownConverter) SupportedExtensions() []string {
	return []string{".md", ".markdown"}
}

// Name returns the converter name for logging.
func (c *markdownConverter) Name() string {
	return "markdown"
}
