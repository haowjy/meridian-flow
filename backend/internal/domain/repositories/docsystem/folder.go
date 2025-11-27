package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// FolderRepository defines data access operations for folders
type FolderRepository interface {
	// Create creates a new folder
	Create(ctx context.Context, folder *docsystem.Folder) error

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

	// GetPath computes the path for a folder
	GetPath(ctx context.Context, folderID *string, projectID string) (string, error)

	// GetAllByProject retrieves all folders in a project (flat list)
	GetAllByProject(ctx context.Context, projectID string) ([]docsystem.Folder, error)
}
