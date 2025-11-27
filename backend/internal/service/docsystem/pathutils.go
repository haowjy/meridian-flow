package docsystem

import (
	"fmt"
	"strings"
)

// pathutils.go - Shared path construction utilities for import processors.
//
// These functions centralize path-related logic used during document import
// to ensure consistent behavior across ZipFileProcessor and IndividualFileProcessor.

// BuildFullPath constructs a display path from folder path and document name.
// Returns just docName if folderPath is empty (root-level document).
//
// Examples:
//   - BuildFullPath("chapters", "intro") → "chapters/intro"
//   - BuildFullPath("", "readme") → "readme"
func BuildFullPath(folderPath, docName string) string {
	if folderPath == "" {
		return docName
	}
	return folderPath + "/" + docName
}

// BuildLookupKey creates a unique key for document deduplication during import.
//
// The key format is "path|name" where:
//   - path: The document's folder path (empty string for root-level docs)
//   - name: The document's name (without file extension)
//
// This format ensures uniqueness since the same name can exist in different folders.
// The pipe separator is safe because document names cannot contain pipes.
//
// Example:
//   - BuildLookupKey("chapters/intro", "intro") → "chapters/intro|intro"
func BuildLookupKey(path, name string) string {
	return fmt.Sprintf("%s|%s", path, name)
}

// SanitizeDocName removes or replaces invalid characters from document names.
//
// Currently handles:
//   - "/" → "-" (prevents path injection, maintains readability)
//
// This is applied during import to ensure document names are valid for
// the file system and don't interfere with path construction.
func SanitizeDocName(name string) string {
	return strings.ReplaceAll(name, "/", "-")
}
