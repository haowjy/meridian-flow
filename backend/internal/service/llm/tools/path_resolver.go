package tools

import (
	"context"
	"fmt"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// PathResolver handles resolution of folder paths to folder IDs.
// Uses FolderService for all data access (SOLID: DIP - depends on service interface).
type PathResolver struct {
	projectID string
	userID    string
	folderSvc docsysSvc.FolderService
}

// NewPathResolver creates a new PathResolver instance.
// Uses service interface for all data access (SOLID: DIP - depends on interfaces, not concretions).
func NewPathResolver(
	projectID string,
	userID string,
	folderSvc docsysSvc.FolderService,
) *PathResolver {
	return &PathResolver{
		projectID: projectID,
		userID:    userID,
		folderSvc: folderSvc,
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
// Uses FolderService.ListChildren which returns both folders and documents.
func (r *PathResolver) findFolderByName(ctx context.Context, parentID *string, name string) (*docsystem.Folder, error) {
	// Get folder contents using service layer (returns both folders and documents)
	contents, err := r.folderSvc.ListChildren(ctx, r.userID, parentID, r.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folders: %w", err)
	}

	// Find folder with matching name
	for _, folder := range contents.Folders {
		if folder.Name == name {
			return &folder, nil
		}
	}

	return nil, domain.NewNotFoundError("folder",
		fmt.Sprintf("folder '%s' not found", name))
}
