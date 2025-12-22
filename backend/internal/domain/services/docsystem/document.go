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
	// AIVersion field supports tri-state: absent=don't change, null=clear, value=set
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

// OptionalAIVersion tracks tri-state semantics for ai_version updates (RFC 7396 PATCH).
// This is transport-agnostic (no JSON tags) - handler maps from httputil.OptionalString.
//   - Present=false: field absent from request (don't change)
//   - Present=true, Value=nil: field is null (clear/set to NULL)
//   - Present=true, Value=&"": field is empty string
//   - Present=true, Value=&"text": field has value
type OptionalAIVersion struct {
	Present bool    // true if field was in request
	Value   *string // nil = clear, non-nil = set (including empty string)
}

// UpdateDocumentRequest represents a document update request
// Uses OptionalFolderID from folder.go (same package) for folder_id tri-state semantics
type UpdateDocumentRequest struct {
	ProjectID  string           `json:"project_id"`
	Name       *string          `json:"name,omitempty"`
	FolderPath *string          `json:"folder_path,omitempty"` // Move to folder path (resolve/auto-create)
	FolderID   OptionalFolderID // Tri-state: absent=don't change, null=root, value=folder (no json tag - mapped from handler DTO)
	Content    *string          `json:"content,omitempty"`
	AIVersion  OptionalAIVersion // Tri-state: absent=don't change, null=clear, value=set
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
