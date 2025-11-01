package repositories

import (
	"context"

	"meridian/internal/domain/models"
)

// DocumentRepository defines data access operations for documents
type DocumentRepository interface {
	// Create creates a new document
	Create(ctx context.Context, doc *models.Document) error

	// GetByID retrieves a document by ID
	GetByID(ctx context.Context, id, projectID string) (*models.Document, error)

	// Update updates an existing document
	Update(ctx context.Context, doc *models.Document) error

	// Delete deletes a document
	Delete(ctx context.Context, id, projectID string) error

	// DeleteAllByProject deletes all documents in a project
	DeleteAllByProject(ctx context.Context, projectID string) error

	// ListByFolder lists documents in a folder
	ListByFolder(ctx context.Context, folderID *string, projectID string) ([]models.Document, error)

	// GetPath computes the display path for a document
	GetPath(ctx context.Context, doc *models.Document) (string, error)

	// GetAllMetadataByProject retrieves all document metadata in a project (no content)
	GetAllMetadataByProject(ctx context.Context, projectID string) ([]models.Document, error)
}
