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
	// userID is used for authorization check
	GetFolder(ctx context.Context, userID, folderID string) (*docsystem.Folder, error)

	// UpdateFolder updates a folder (rename or move)
	// userID is used for authorization check
	UpdateFolder(ctx context.Context, userID, folderID string, req *UpdateFolderRequest) (*docsystem.Folder, error)

	// DeleteFolder deletes a folder (must be empty)
	// userID is used for authorization check
	DeleteFolder(ctx context.Context, userID, folderID string) error

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

// OptionalFolderID tracks tri-state semantics for folder_id updates (RFC 7396 PATCH).
// This is transport-agnostic (no JSON tags) - handler maps from httputil.OptionalString.
//   - Present=false: field absent from request (don't change)
//   - Present=true, Value=nil: field is null (move to root)
//   - Present=true, Value=&"uuid": move to specified folder
type OptionalFolderID struct {
	Present bool    // true if field was in request
	Value   *string // nil = move to root, non-nil = move to folder UUID
}

// UpdateFolderRequest represents a folder update request
type UpdateFolderRequest struct {
	ProjectID string           `json:"project_id"`
	Name      *string          `json:"name,omitempty"` // rename
	FolderID  OptionalFolderID // Tri-state: absent=don't change, null=root, value=folder (no json tag - mapped from handler DTO)
}

// FolderContents represents a folder with its children
type FolderContents struct {
	Folder    *docsystem.Folder    `json:"folder,omitempty"` // null for root
	Folders   []docsystem.Folder   `json:"folders"`
	Documents []docsystem.Document `json:"documents"`
}
