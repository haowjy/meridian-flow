package docsystem

import (
	"context"
)

// PathNotationResult contains the result of path notation resolution
type PathNotationResult struct {
	ResolvedFolderID *string // The folder ID where the final item should be created
	FinalName        string  // The name for the final item (document or folder)
}

// PathResolver handles folder path resolution and creation
type PathResolver interface {
	// ResolveFolderPath resolves a folder path to a folder ID, creating folders if needed
	// Returns nil for empty path (root level)
	// Example: "Characters/Villains" -> folder ID of "Villains"
	ResolveFolderPath(ctx context.Context, projectID, folderPath string) (*string, error)

	// ValidateFolderPath validates a folder path format
	ValidateFolderPath(path string) error

	// ResolvePathNotation handles Unix-style path notation in names with priority-based folder resolution:
	//   Priority 1: Use folderID if provided
	//   Priority 2: Use folderPath if provided (resolve/create folders)
	//   Priority 3: Use root (nil) if neither provided
	// Supports:
	//   - "name" → simple name at resolved parent
	//   - "a/b/c" → relative path (auto-create intermediate folders a, b)
	//   - "/a/b/c" → absolute path from root (ignore folderID and folderPath)
	// Returns the resolved parent folder ID and final name
	ResolvePathNotation(ctx context.Context, req *PathNotationRequest) (*PathNotationResult, error)
}

// PathNotationRequest contains parameters for path notation resolution
type PathNotationRequest struct {
	ProjectID      string
	Name           string  // Name that may contain path notation
	FolderID       *string // Priority 1: Direct folder ID
	FolderPath     *string // Priority 2: Folder path to resolve
	MaxNameLength  int     // Maximum length for final name validation
}
