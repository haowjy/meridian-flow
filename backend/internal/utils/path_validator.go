package utils

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	MaxPathLength = 500
)

var (
	// Allow alphanumeric, spaces, hyphens, underscores, and forward slashes for folders
	pathRegex = regexp.MustCompile(`^[a-zA-Z0-9\s\-_/]+$`)
)

// ValidatePath validates a document path
func ValidatePath(path string) error {
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}

	if len(path) > MaxPathLength {
		return fmt.Errorf("path exceeds maximum length of %d characters", MaxPathLength)
	}

	// Trim whitespace
	path = strings.TrimSpace(path)

	// Check for valid characters
	if !pathRegex.MatchString(path) {
		return fmt.Errorf("path contains invalid characters (only alphanumeric, spaces, hyphens, underscores, and slashes allowed)")
	}

	// Check for double slashes
	if strings.Contains(path, "//") {
		return fmt.Errorf("path cannot contain consecutive slashes")
	}

	// Check for leading or trailing slashes
	if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("path cannot start or end with a slash")
	}

	// Check each segment
	segments := strings.Split(path, "/")
	for _, segment := range segments {
		if strings.TrimSpace(segment) == "" {
			return fmt.Errorf("path cannot contain empty segments")
		}
	}

	return nil
}

// NormalizePath normalizes a document path (trims whitespace, etc.)
func NormalizePath(path string) string {
	path = strings.TrimSpace(path)
	
	// Normalize multiple spaces to single space
	path = strings.Join(strings.Fields(path), " ")
	
	return path
}

