package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
	"meridian/internal/optional"
)

// DocumentService handles document business logic
type DocumentService interface {
	// CreateDocument creates a new document, resolving path to folders
	CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*docsystem.Document, error)

	// GetDocument retrieves a document with its computed path
	// userID is used for authorization check
	GetDocument(ctx context.Context, userID, documentID string) (*docsystem.Document, error)

	// GetDocumentByPath retrieves a document by its Unix-style path within a project
	// userID is used for authorization check (validates project access)
	// path is the Unix-style path (e.g., "/Characters/Aria.md")
	GetDocumentByPath(ctx context.Context, userID, path, projectID string) (*docsystem.Document, error)

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

	// UpdateAIVersion updates only the ai_version field for a document
	// This is a convenience method for LLM tools that only need to update ai_version
	// userID is used for authorization check
	UpdateAIVersion(ctx context.Context, userID, documentID string, aiVersion *string) (*docsystem.Document, error)
}

// CreateDocumentRequest represents a document creation request
type CreateDocumentRequest struct {
	ProjectID  string  `json:"project_id"`
	UserID     string  `json:"-"`                     // Set by handler from auth context, not from request body
	FolderPath *string `json:"folder_path,omitempty"` // Folder path (e.g., "Characters/Aria" or "Characters" or "" for root)
	FolderID   *string `json:"folder_id,omitempty"`   // Direct folder assignment (alternative to FolderPath)
	Name       string  `json:"name"`                  // Document name without extension (required)
	Extension  string  `json:"extension"`             // File extension with leading dot (e.g., ".md"), defaults to ".md" if empty
	Content    string  `json:"content"`               // Markdown content
}

// UpdateDocumentRequest represents a document update request
// Uses optional.Optional[string] for FolderID and AIVersion tri-state semantics (RFC 7396 PATCH)
type UpdateDocumentRequest struct {
	ProjectID  string
	Name       *string
	Extension  *string                   // Optional extension change (e.g., ".md" -> ".txt")
	FolderPath *string                   // Move to folder path (resolve/auto-create)
	FolderID   optional.Optional[string] // Tri-state: absent=don't change, null=root, value=folder
	Content    *string
	AIVersion  optional.Optional[string] // Tri-state: absent=don't change, null=clear, value=set
	// AIVersionBaseRev is the client's last-seen ai_version_rev.
	// Required when AIVersion.Present is true. Used for CAS (compare-and-swap) check.
	AIVersionBaseRev int
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
