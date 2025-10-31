package services

import (
	"context"

	"github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// DocumentService handles document business logic
type DocumentService interface {
	// CreateDocument creates a new document, resolving path to folders
	CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*models.Document, error)

	// GetDocument retrieves a document with its computed path
	GetDocument(ctx context.Context, id, projectID string) (*models.Document, error)

	// UpdateDocument updates a document
	UpdateDocument(ctx context.Context, id string, req *UpdateDocumentRequest) (*models.Document, error)

	// DeleteDocument deletes a document
	DeleteDocument(ctx context.Context, id, projectID string) error
}

// CreateDocumentRequest represents a document creation request
type CreateDocumentRequest struct {
	ProjectID     string
	Path          *string                // Path-based creation (e.g., "Characters/Aria")
	FolderID      *string                // Direct folder assignment
	Name          *string                // Document name (if not using path)
	ContentTipTap map[string]interface{} // TipTap JSON
}

// UpdateDocumentRequest represents a document update request
type UpdateDocumentRequest struct {
	ProjectID     string
	Name          *string
	FolderID      *string
	ContentTipTap *map[string]interface{}
}
