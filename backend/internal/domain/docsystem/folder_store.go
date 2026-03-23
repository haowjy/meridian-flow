package docsystem

import (
	"context"
)

// FolderFilterOptions controls which folders are returned
type FolderFilterOptions struct {
	IncludeHidden bool // Default false: exclude hidden/system folders
}

// FolderStore defines data access operations for folders
type FolderStore interface {
	// Create creates a new folder
	Create(ctx context.Context, folder *Folder) error

	// CreateHidden creates a new hidden folder (e.g., for /.meridian/)
	CreateHidden(ctx context.Context, folder *Folder) error

	// GetByID retrieves a folder by ID with project scoping
	GetByID(ctx context.Context, id, projectID string) (*Folder, error)

	// GetByIDOnly retrieves a folder by UUID only (no project scoping)
	// Use when authorization is handled separately (e.g., by ResourceAuthorizer)
	GetByIDOnly(ctx context.Context, id string) (*Folder, error)

	// Update updates a folder
	Update(ctx context.Context, folder *Folder) error

	// Delete deletes a folder
	Delete(ctx context.Context, id, projectID string) (*Folder, error)

	// ListChildren lists immediate child folders
	// If opts is nil, uses default options (IncludeHidden: false)
	ListChildren(ctx context.Context, folderID *string, projectID string, opts *FolderFilterOptions) ([]Folder, error)

	// CreateIfNotExists creates a folder only if it doesn't exist
	CreateIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*Folder, error)

	// CreateHiddenIfNotExists creates a hidden folder only if it doesn't exist
	CreateHiddenIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*Folder, error)

	// CreateSystemIfNotExists creates a root-level system folder only if it doesn't exist.
	CreateSystemIfNotExists(ctx context.Context, projectID, name string, autoapply *bool) (*Folder, error)

	// GetPath computes the path for a folder
	GetPath(ctx context.Context, folderID *string, projectID string) (string, error)

	// GetAllByProject retrieves all folders in a project (flat list)
	GetAllByProject(ctx context.Context, projectID string) ([]Folder, error)

	// GetAllByProjectFiltered retrieves folders with filtering options
	GetAllByProjectFiltered(ctx context.Context, projectID string, opts FolderFilterOptions) ([]Folder, error)

	// GetByPath retrieves a folder by its full path
	GetByPath(ctx context.Context, projectID string, path string) (*Folder, error)
}
