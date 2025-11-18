package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// DocumentRepository defines data access operations for documents
type DocumentRepository interface {
	// Create creates a new document
	Create(ctx context.Context, doc *docsystem.Document) error

	// GetByID retrieves a document by ID
	GetByID(ctx context.Context, id, projectID string) (*docsystem.Document, error)

	// GetByPath retrieves a document by its path (e.g., ".skills/cw-prose-writing/SKILL.md")
	GetByPath(ctx context.Context, path string, projectID string) (*docsystem.Document, error)

	// Update updates an existing document
	Update(ctx context.Context, doc *docsystem.Document) error

	// Delete deletes a document
	Delete(ctx context.Context, id, projectID string) error

	// DeleteAllByProject deletes all documents in a project
	DeleteAllByProject(ctx context.Context, projectID string) error

	// ListByFolder lists documents in a folder
	ListByFolder(ctx context.Context, folderID *string, projectID string) ([]docsystem.Document, error)

	// GetPath computes the display path for a document
	GetPath(ctx context.Context, doc *docsystem.Document) (string, error)

	// GetAllMetadataByProject retrieves all document metadata in a project (no content)
	GetAllMetadataByProject(ctx context.Context, projectID string) ([]docsystem.Document, error)
}
