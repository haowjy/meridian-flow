package utils

import (
	"fmt"
	"strings"

	"github.com/jimmyyao/meridian/backend/internal/database"
)

// ResolvePathResult contains the result of path resolution
type ResolvePathResult struct {
	FolderID *string // The folder ID where the document should be created (nil = root)
	Name     string  // The document name extracted from the path
}

// ResolvePath parses a path like "Characters/Villains/Boss" and:
// 1. Creates folders if they don't exist ("Characters", "Villains")
// 2. Returns the folder_id and document name ("Boss")
func ResolvePath(db *database.DB, projectID string, path string) (*ResolvePathResult, error) {
	// Trim leading/trailing slashes
	path = strings.Trim(path, "/")
	if path == "" {
		return nil, fmt.Errorf("path cannot be empty")
	}

	// Split path into segments
	segments := strings.Split(path, "/")
	if len(segments) == 0 {
		return nil, fmt.Errorf("invalid path")
	}

	// Last segment is the document name
	docName := segments[len(segments)-1]

	// If there's only one segment, it's a root-level document
	if len(segments) == 1 {
		return &ResolvePathResult{
			FolderID: nil,
			Name:     docName,
		}, nil
	}

	// Create folders for all segments except the last one
	folderSegments := segments[:len(segments)-1]
	folderID, err := createFolderHierarchy(db, projectID, folderSegments)
	if err != nil {
		return nil, err
	}

	return &ResolvePathResult{
		FolderID: folderID,
		Name:     docName,
	}, nil
}

// createFolderHierarchy creates a hierarchy of folders, creating them if they don't exist
// Returns the ID of the final folder in the hierarchy
func createFolderHierarchy(db *database.DB, projectID string, segments []string) (*string, error) {
	var currentParentID *string // Start at root

	for _, segment := range segments {
		// Validate folder name
		if err := ValidateFolderName(segment); err != nil {
			return nil, err
		}

		// Create folder if it doesn't exist
		folder, err := db.CreateFolderIfNotExists(projectID, currentParentID, segment)
		if err != nil {
			return nil, fmt.Errorf("failed to create/get folder '%s': %w", segment, err)
		}

		// Move to next level
		currentParentID = &folder.ID
	}

	return currentParentID, nil
}

// ExtractNameFromPath extracts just the document name from a full path
// "Characters/Villains/Boss" → "Boss"
// "Standalone Doc" → "Standalone Doc"
func ExtractNameFromPath(path string) string {
	path = strings.Trim(path, "/")
	segments := strings.Split(path, "/")
	return segments[len(segments)-1]
}

// ValidateFolderName validates a folder name (no slashes, reasonable length)
func ValidateFolderName(name string) error {
	if name == "" {
		return fmt.Errorf("folder name cannot be empty")
	}
	if len(name) > 255 {
		return fmt.Errorf("folder name too long (max 255 characters)")
	}
	if strings.Contains(name, "/") {
		return fmt.Errorf("folder name cannot contain slashes")
	}
	// Allow alphanumeric, spaces, hyphens, underscores
	// You can add more validation here if needed
	return nil
}

// ValidateDocumentName validates a document name (similar to folder name)
func ValidateDocumentName(name string) error {
	if name == "" {
		return fmt.Errorf("document name cannot be empty")
	}
	if len(name) > 500 {
		return fmt.Errorf("document name too long (max 500 characters)")
	}
	if strings.Contains(name, "/") {
		return fmt.Errorf("document name cannot contain slashes")
	}
	return nil
}

