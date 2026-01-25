package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// FolderFilterOptions controls which folders are returned
type FolderFilterOptions struct {
	IncludeHidden bool // Default false: exclude is_hidden=true folders
}

// FolderRepository defines data access operations for folders
type FolderRepository interface {
	// Create creates a new folder
	Create(ctx context.Context, folder *docsystem.Folder) error

	// CreateHidden creates a new hidden folder (e.g., for /.meridian/)
	CreateHidden(ctx context.Context, folder *docsystem.Folder) error

	// GetByID retrieves a folder by ID with project scoping
	GetByID(ctx context.Context, id, projectID string) (*docsystem.Folder, error)

	// GetByIDOnly retrieves a folder by UUID only (no project scoping)
	// Use when authorization is handled separately (e.g., by ResourceAuthorizer)
	GetByIDOnly(ctx context.Context, id string) (*docsystem.Folder, error)

	// Update updates a folder
	Update(ctx context.Context, folder *docsystem.Folder) error

	// Delete deletes a folder
	Delete(ctx context.Context, id, projectID string) error

	// ListChildren lists immediate child folders
	ListChildren(ctx context.Context, folderID *string, projectID string) ([]docsystem.Folder, error)

	// CreateIfNotExists creates a folder only if it doesn't exist
	CreateIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*docsystem.Folder, error)

	// CreateHiddenIfNotExists creates a hidden folder only if it doesn't exist
	CreateHiddenIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*docsystem.Folder, error)

	// GetPath computes the path for a folder
	GetPath(ctx context.Context, folderID *string, projectID string) (string, error)

	// GetAllByProject retrieves all folders in a project (flat list)
	GetAllByProject(ctx context.Context, projectID string) ([]docsystem.Folder, error)

	// GetAllByProjectFiltered retrieves folders with filtering options
	GetAllByProjectFiltered(ctx context.Context, projectID string, opts FolderFilterOptions) ([]docsystem.Folder, error)

	// GetByPath retrieves a folder by its full path
	GetByPath(ctx context.Context, projectID string, path string) (*docsystem.Folder, error)
}
