package docsystem

import "context"

// ContentConverter converts file content to markdown format.
// Each converter handles a specific file type (html, txt, docx, pdf, etc.)
// and produces normalized markdown suitable for storage.
//
// Implementations should be stateless and thread-safe.
type ContentConverter interface {
	// Convert transforms input content to markdown.
	// Returns an error if conversion fails.
	Convert(ctx context.Context, input []byte) (markdown string, err error)

	// SupportedExtensions returns file extensions this converter handles.
	// Extensions should include the leading dot (e.g., [".html", ".htm"]).
	SupportedExtensions() []string

	// Name returns a human-readable converter name for logging/debugging.
	Name() string
}
