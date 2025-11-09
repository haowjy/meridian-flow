package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// DocumentService handles document business logic
type DocumentService interface {
	// CreateDocument creates a new document, resolving path to folders
	CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*docsystem.Document, error)

	// GetDocument retrieves a document with its computed path
	GetDocument(ctx context.Context, id, projectID string) (*docsystem.Document, error)

	// UpdateDocument updates a document
	UpdateDocument(ctx context.Context, id string, req *UpdateDocumentRequest) (*docsystem.Document, error)

	// DeleteDocument deletes a document
	DeleteDocument(ctx context.Context, id, projectID string) error
}

// CreateDocumentRequest represents a document creation request
type CreateDocumentRequest struct {
	ProjectID  string  `json:"project_id"`
	UserID     string  `json:"-"` // Set by handler from auth context, not from request body
	FolderPath *string `json:"folder_path,omitempty"` // Folder path (e.g., "Characters/Aria" or "Characters" or "" for root)
	FolderID   *string `json:"folder_id,omitempty"`   // Direct folder assignment (alternative to FolderPath)
	Name       string  `json:"name"`                  // Document name (required)
	Content    string  `json:"content"`               // Markdown content
}

// UpdateDocumentRequest represents a document update request
type UpdateDocumentRequest struct {
	ProjectID  string  `json:"project_id"`
	Name       *string `json:"name,omitempty"`
	FolderPath *string `json:"folder_path,omitempty"` // Move to folder path (resolve/auto-create)
	FolderID   *string `json:"folder_id,omitempty"`   // Move to folder ID (direct, faster)
	Content    *string `json:"content,omitempty"`
}
