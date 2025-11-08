package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// FolderService handles folder business logic
type FolderService interface {
	// CreateFolder creates a new folder
	CreateFolder(ctx context.Context, req *CreateFolderRequest) (*docsystem.Folder, error)

	// GetFolder retrieves a folder with its computed path
	GetFolder(ctx context.Context, id, projectID string) (*docsystem.Folder, error)

	// UpdateFolder updates a folder (rename or move)
	UpdateFolder(ctx context.Context, id string, req *UpdateFolderRequest) (*docsystem.Folder, error)

	// DeleteFolder deletes a folder (must be empty)
	DeleteFolder(ctx context.Context, id, projectID string) error

	// ListChildren lists all child folders and documents
	ListChildren(ctx context.Context, folderID *string, projectID string) (*FolderContents, error)
}

// CreateFolderRequest represents a folder creation request
type CreateFolderRequest struct {
	ProjectID  string  `json:"project_id"`
	Name       string  `json:"name"`
	FolderID   *string `json:"folder_id,omitempty"`   // Parent folder ID (null for root)
	FolderPath *string `json:"folder_path,omitempty"` // Alternative: resolve path to folder
}

// UpdateFolderRequest represents a folder update request
type UpdateFolderRequest struct {
	ProjectID string  `json:"project_id"`
	Name      *string `json:"name,omitempty"`      // rename
	FolderID  *string `json:"folder_id,omitempty"` // move (use empty string for root)
}

// FolderContents represents a folder with its children
type FolderContents struct {
	Folder    *docsystem.Folder    `json:"folder,omitempty"` // null for root
	Folders   []docsystem.Folder   `json:"folders"`
	Documents []docsystem.Document `json:"documents"`
}
