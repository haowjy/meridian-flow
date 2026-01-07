package docsystem

import "strings"

// FileType represents the editor/storage type for a document.
// Derived from file extension, not stored in database.
type FileType string

const (
	FileTypeMarkdown   FileType = "markdown"
	FileTypeExcalidraw FileType = "excalidraw"
	FileTypeMermaid    FileType = "mermaid"
)

// Default extension for new documents
const DefaultExtension = ".md"

// ExtensionToFileType maps file extensions to their corresponding FileType.
// Extensions are lowercase with leading dot.
var ExtensionToFileType = map[string]FileType{
	".md":         FileTypeMarkdown,
	".markdown":   FileTypeMarkdown,
	".txt":        FileTypeMarkdown,
	".excalidraw": FileTypeExcalidraw,
	".mmd":        FileTypeMermaid,
	".mermaid":    FileTypeMermaid,
}

// ValidExtensions returns all supported extensions
func ValidExtensions() []string {
	extensions := make([]string, 0, len(ExtensionToFileType))
	for ext := range ExtensionToFileType {
		extensions = append(extensions, ext)
	}
	return extensions
}

// FileTypeFromExtension returns the FileType for a given extension.
// Returns FileTypeMarkdown as default for unknown extensions.
func FileTypeFromExtension(ext string) FileType {
	ext = strings.ToLower(ext)
	if ft, ok := ExtensionToFileType[ext]; ok {
		return ft
	}
	return FileTypeMarkdown // default
}

// IsValidExtension checks if an extension is supported.
func IsValidExtension(ext string) bool {
	ext = strings.ToLower(ext)
	_, ok := ExtensionToFileType[ext]
	return ok
}

// NormalizeExtension normalizes an extension string:
// - Lowercase
// - Ensures leading dot
// - Returns DefaultExtension if empty
func NormalizeExtension(ext string) string {
	ext = strings.TrimSpace(ext)
	ext = strings.ToLower(ext)

	if ext == "" {
		return DefaultExtension
	}

	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}

	return ext
}

// IsTextBasedFileType returns true for file types that store content in the database.
// Binary file types (future) will use S3 storage instead.
func IsTextBasedFileType(ft FileType) bool {
	switch ft {
	case FileTypeMarkdown, FileTypeMermaid:
		return true
	case FileTypeExcalidraw:
		// Excalidraw stores JSON in content, which is text-based
		// but may move to S3 for large drawings in the future
		return true
	default:
		return true // default to text-based for safety
	}
}

// IsMarkdownExtension returns true if the extension is a supported markdown-family extension.
// This is used for behaviors that are only meaningful for prose (e.g., word count).
func IsMarkdownExtension(ext string) bool {
	ext = strings.TrimSpace(ext)
	ext = strings.ToLower(ext)
	if ext == "" {
		return false
	}
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}

	ft, ok := ExtensionToFileType[ext]
	if !ok {
		return false
	}
	return ft == FileTypeMarkdown
}
