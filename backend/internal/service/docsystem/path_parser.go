package docsystem

import (
	"fmt"
	"strings"
	"unicode"
)

// PathParseResult contains the parsed components of a path
type PathParseResult struct {
	Segments   []string // Individual path segments (e.g., ["Characters", "Villains", "name"])
	IsAbsolute bool     // True if path starts with "/" (absolute from root)
	FinalName  string   // The final segment (actual folder/document name)
	ParentPath []string // All segments except the final one
}

// ParsePath parses a name field that may contain Unix-style path notation.
//
// Path conventions:
//   - Leading "/" means absolute path from root (ignore folder_id)
//   - No leading "/" means relative to folder_id
//   - Segments are split by "/"
//   - Final segment is the actual name
//
// Examples:
//   - "name" → {["name"], false, "name", []}
//   - "a/b/c" → {["a", "b", "c"], false, "c", ["a", "b"]}
//   - "/a/b/c" → {["a", "b", "c"], true, "c", ["a", "b"]}
//
// Validation (strict):
//   - No consecutive slashes ("a//b" → error)
//   - No trailing slash ("a/" → error)
//   - No empty segments
//   - Each segment must be valid name (alphanumeric, spaces, hyphens, underscores)
//   - Each segment must not exceed max length
func ParsePath(name string, maxSegmentLength int) (*PathParseResult, error) {
	if name == "" {
		return nil, fmt.Errorf("name cannot be empty")
	}

	// Detect absolute vs relative
	isAbsolute := strings.HasPrefix(name, "/")

	// Remove leading slash if present (for parsing)
	pathWithoutLeadingSlash := strings.TrimPrefix(name, "/")

	// Strict validation: no trailing slashes
	if strings.HasSuffix(pathWithoutLeadingSlash, "/") {
		return nil, fmt.Errorf("path cannot end with '/'")
	}

	// Strict validation: no consecutive slashes
	if strings.Contains(pathWithoutLeadingSlash, "//") {
		return nil, fmt.Errorf("path cannot contain consecutive slashes '//'")
	}

	// Split into segments
	segments := strings.Split(pathWithoutLeadingSlash, "/")

	// Validate each segment
	for i, segment := range segments {
		// Empty segments (shouldn't happen after above checks, but defensive)
		if segment == "" {
			return nil, fmt.Errorf("path contains empty segment at position %d", i)
		}

		// Trim whitespace
		segment = strings.TrimSpace(segment)
		segments[i] = segment

		if segment == "" {
			return nil, fmt.Errorf("path segment at position %d is empty after trimming whitespace", i)
		}

		// Length check
		if len(segment) > maxSegmentLength {
			return nil, fmt.Errorf("path segment '%s' exceeds maximum length of %d", segment, maxSegmentLength)
		}

		// Character validation: only alphanumeric, spaces, hyphens, underscores
		// (NO slashes - those are path separators)
		for _, char := range segment {
			if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
				char != ' ' && char != '-' && char != '_' {
				return nil, fmt.Errorf("path segment '%s' contains invalid character: %c", segment, char)
			}
		}
	}

	// Extract final name and parent path
	finalName := segments[len(segments)-1]
	var parentPath []string
	if len(segments) > 1 {
		parentPath = segments[:len(segments)-1]
	}

	return &PathParseResult{
		Segments:   segments,
		IsAbsolute: isAbsolute,
		FinalName:  finalName,
		ParentPath: parentPath,
	}, nil
}

// IsPathNotation returns true if the name contains path separators
func IsPathNotation(name string) bool {
	return strings.Contains(name, "/")
}

// ValidateSimpleName validates a name that should NOT contain path notation.
// This is used after path parsing to validate the final segment.
func ValidateSimpleName(name string, maxLength int) error {
	name = strings.TrimSpace(name)

	if name == "" {
		return fmt.Errorf("name cannot be empty")
	}

	if len(name) > maxLength {
		return fmt.Errorf("name exceeds maximum length of %d", maxLength)
	}

	// Simple names cannot contain slashes
	if strings.Contains(name, "/") {
		return fmt.Errorf("name cannot contain '/' character")
	}

	return nil
}

// ResolveParentID resolves the parent ID based on path notation rules:
//   - If path is absolute (starts with "/"), return nil (root) regardless of providedParentID
//   - If path is relative, return providedParentID (which may be nil for root)
func ResolveParentID(isAbsolute bool, providedParentID *string) *string {
	if isAbsolute {
		return nil // Absolute path always starts from root
	}
	return providedParentID // Relative path uses provided parent (or nil for root)
}
