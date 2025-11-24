package converter

import (
	"context"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

// textConverter converts plain text files to markdown.
// Since plain text is valid markdown, this is effectively a passthrough.
type textConverter struct{}

// NewTextConverter creates a new text converter.
func NewTextConverter() docsysSvc.ContentConverter {
	return &textConverter{}
}

// Convert returns the input as-is since plain text is valid markdown.
func (c *textConverter) Convert(ctx context.Context, input []byte) (string, error) {
	return string(input), nil
}

// SupportedExtensions returns text file extensions.
func (c *textConverter) SupportedExtensions() []string {
	return []string{".txt", ".text"}
}

// Name returns the converter name for logging.
func (c *textConverter) Name() string {
	return "plaintext"
}
