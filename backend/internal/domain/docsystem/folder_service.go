package docsystem

import (
	"context"

	"meridian/internal/optional"
)

// FolderService handles folder business logic
type FolderService interface {
	// CreateFolder creates a new folder
	CreateFolder(ctx context.Context, req *CreateFolderRequest) (*Folder, error)

	// GetFolder retrieves a folder with its computed path
	// userID is used for authorization check
	GetFolder(ctx context.Context, userID, folderID string) (*Folder, error)

	// UpdateFolder updates a folder (rename or move)
	// userID is used for authorization check
	UpdateFolder(ctx context.Context, userID, folderID string, req *UpdateFolderRequest) (*Folder, error)

	// DeleteFolder deletes a folder (must be empty)
	// userID is used for authorization check
	DeleteFolder(ctx context.Context, userID, folderID string) (*Folder, error)

	// ListChildren lists all child folders and documents
	// userID is used for authorization check, folderID is optional (nil for root)
	ListChildren(ctx context.Context, userID string, folderID *string, projectID string) (*FolderContents, error)
}

// CreateFolderRequest represents a folder creation request
type CreateFolderRequest struct {
	ProjectID  string  `json:"project_id"`
	UserID     string  `json:"-"` // Set by handler from auth context, not from request body
	Name       string  `json:"name"`
	FolderID   *string `json:"folder_id,omitempty"`   // Parent folder ID (null for root)
	FolderPath *string `json:"folder_path,omitempty"` // Alternative: resolve path to folder
}

// UpdateFolderRequest represents a folder update request
// Uses optional.Optional[string] for FolderID tri-state semantics (RFC 7396 PATCH)
// ProjectID is not needed — derived from the folder record via folderID in the URL.
type UpdateFolderRequest struct {
	Name     *string                   // rename
	FolderID optional.Optional[string] // Tri-state: absent=don't change, null=root, value=folder
}

// FolderContents represents a folder with its children
type FolderContents struct {
	Folder    *Folder    `json:"folder,omitempty"` // null for root
	Folders   []Folder   `json:"folders"`
	Documents []Document `json:"documents"`
}
