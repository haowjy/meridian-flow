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
	ProjectID     string                 `json:"project_id"`
	Path          *string                `json:"path,omitempty"`          // Path-based creation (e.g., "Characters/Aria")
	FolderID      *string                `json:"folder_id,omitempty"`     // Direct folder assignment
	Name          *string                `json:"name,omitempty"`          // Document name (if not using path)
	ContentTipTap map[string]interface{} `json:"content_tiptap"`          // TipTap JSON
}

// UpdateDocumentRequest represents a document update request
type UpdateDocumentRequest struct {
	ProjectID     string                  `json:"project_id"`
	Name          *string                 `json:"name,omitempty"`
	FolderID      *string                 `json:"folder_id,omitempty"`
	ContentTipTap *map[string]interface{} `json:"content_tiptap,omitempty"`
}
