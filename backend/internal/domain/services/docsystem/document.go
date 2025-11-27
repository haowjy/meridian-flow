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
	// userID is used for authorization check
	GetDocument(ctx context.Context, userID, documentID string) (*docsystem.Document, error)

	// UpdateDocument updates a document
	// userID is used for authorization check
	UpdateDocument(ctx context.Context, userID, documentID string, req *UpdateDocumentRequest) (*docsystem.Document, error)

	// DeleteDocument deletes a document
	// userID is used for authorization check
	DeleteDocument(ctx context.Context, userID, documentID string) error

	// SearchDocuments performs full-text search across documents
	// userID is used to filter results to user's accessible projects
	SearchDocuments(ctx context.Context, userID string, req *SearchDocumentsRequest) (*docsystem.SearchResults, error)
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

// SearchDocumentsRequest represents a document search request
type SearchDocumentsRequest struct {
	Query     string   `json:"query"`                // Search query (required)
	ProjectID string   `json:"project_id,omitempty"` // Optional - empty means search all user's projects
	Fields    []string `json:"fields,omitempty"`     // Which fields to search: "name", "content" (default: both)
	Limit     int      `json:"limit,omitempty"`      // Results per page (default: 20, max: 100)
	Offset    int      `json:"offset,omitempty"`     // Skip N results (default: 0)
	Language  string   `json:"language,omitempty"`   // FTS language config (default: "english")
	FolderID  *string  `json:"folder_id,omitempty"`  // Optional folder filter
}
