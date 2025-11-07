package docsystem

import (
	"context"
)

// PathResolver handles folder path resolution and creation
type PathResolver interface {
	// ResolveFolderPath resolves a folder path to a folder ID, creating folders if needed
	// Returns nil for empty path (root level)
	// Example: "Characters/Villains" -> folder ID of "Villains"
	ResolveFolderPath(ctx context.Context, projectID, folderPath string) (*string, error)

	// ValidateFolderPath validates a folder path format
	ValidateFolderPath(path string) error
}
