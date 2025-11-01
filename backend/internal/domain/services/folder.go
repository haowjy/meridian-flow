package services

import (
	"context"

	"meridian/internal/domain/models"
)

// FolderService handles folder business logic
type FolderService interface {
	// CreateFolder creates a new folder
	CreateFolder(ctx context.Context, req *CreateFolderRequest) (*models.Folder, error)

	// GetFolder retrieves a folder with its computed path
	GetFolder(ctx context.Context, id, projectID string) (*models.Folder, error)

	// UpdateFolder updates a folder (rename or move)
	UpdateFolder(ctx context.Context, id string, req *UpdateFolderRequest) (*models.Folder, error)

	// DeleteFolder deletes a folder (must be empty)
	DeleteFolder(ctx context.Context, id, projectID string) error

	// ListChildren lists all child folders and documents
	ListChildren(ctx context.Context, folderID *string, projectID string) (*FolderContents, error)
}

// CreateFolderRequest represents a folder creation request
type CreateFolderRequest struct {
	ProjectID string  `json:"project_id"`
	Name      string  `json:"name"`
	ParentID  *string `json:"parent_id,omitempty"` // null for root folders
}

// UpdateFolderRequest represents a folder update request
type UpdateFolderRequest struct {
	ProjectID string  `json:"project_id"`
	Name      *string `json:"name,omitempty"`      // rename
	ParentID  *string `json:"parent_id,omitempty"` // move (use empty string for root)
}

// FolderContents represents a folder with its children
type FolderContents struct {
	Folder    *models.Folder     `json:"folder,omitempty"` // null for root
	Folders   []models.Folder    `json:"folders"`
	Documents []models.Document  `json:"documents"`
}
