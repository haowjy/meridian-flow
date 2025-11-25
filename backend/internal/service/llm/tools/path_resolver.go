package tools

import (
	"context"
	"fmt"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
)

// PathResolver handles resolution of folder paths to folder IDs.
// Extracted from duplicate logic in SearchTool and ViewTool.
type PathResolver struct {
	projectID  string
	FolderRepo docsystemRepo.FolderRepository // Exported for use by tools
}

// NewPathResolver creates a new PathResolver instance.
func NewPathResolver(
	projectID string,
	folderRepo docsystemRepo.FolderRepository,
) *PathResolver {
	return &PathResolver{
		projectID:  projectID,
		FolderRepo: folderRepo,
	}
}

// ResolveFolderPath walks a path to find the corresponding folder ID.
// Returns the folder ID and the resolved path.
//
// Examples:
//   - "" or "/" → returns (nil, "/", nil) for root folder
//   - "novels/chapter1" → returns (&folderId, "/novels/chapter1", nil)
//   - "nonexistent" → returns (nil, "", ErrNotFound)
func (r *PathResolver) ResolveFolderPath(ctx context.Context, path string) (*string, string, error) {
	// Normalize path
	path = strings.Trim(path, "/")
	if path == "" {
		return nil, "/", nil // Root folder
	}

	// Parse path into segments
	segments := strings.Split(path, "/")

	// Walk the path segment by segment
	var currentFolderID *string
	currentPath := "/"

	for _, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}

		// Find folder with this name in the current folder
		folder, err := r.findFolderByName(ctx, currentFolderID, segment)
		if err != nil {
			return nil, "", err
		}

		currentFolderID = &folder.ID
		if currentPath == "/" {
			currentPath = "/" + folder.Name
		} else {
			currentPath = currentPath + "/" + folder.Name
		}
	}

	return currentFolderID, currentPath, nil
}

// findFolderByName finds a folder by name within a parent folder.
func (r *PathResolver) findFolderByName(ctx context.Context, parentID *string, name string) (*docsystem.Folder, error) {
	// Get all child folders
	folders, err := r.FolderRepo.ListChildren(ctx, parentID, r.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folders: %w", err)
	}

	// Find folder with matching name
	for _, folder := range folders {
		if folder.Name == name {
			return &folder, nil
		}
	}

	return nil, fmt.Errorf("folder '%s': %w", name, domain.ErrNotFound)
}
