package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// ViewTool implements the 'view' tool for reading document content or listing folder contents.
// Uses service layer for all data access (SOLID: DIP - depends on interfaces).
// Supports namespace routing: doc_view CAN read /.meridian/** paths for reference materials.
type ViewTool struct {
	projectID    string
	userID       string                        // Required for service layer authorization
	documentSvc  docsysSvc.DocumentService     // For document operations (replaces documentRepo)
	folderSvc    docsysSvc.FolderService       // For folder operations (replaces folderRepo)
	namespaceSvc docsysSvc.NamespaceService    // For namespace routing (optional)
	pathResolver *PathResolver                 // For folder path resolution
	config       *ToolConfig
}

// NewViewTool creates a new ViewTool instance.
// Uses service interfaces for all data access (SOLID: DIP - depends on interfaces, not concretions).
func NewViewTool(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
	config *ToolConfig,
) *ViewTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &ViewTool{
		projectID:    projectID,
		userID:       userID,
		documentSvc:  documentSvc,
		folderSvc:    folderSvc,
		namespaceSvc: namespaceSvc,
		pathResolver: NewPathResolver(projectID, userID, folderSvc),
		config:       config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - path (string, required): Unix-style path to document or folder
//
// Returns either:
//   - Document: {type: "document", id, name, content, path, word_count}
//   - Folder: {type: "folder", path, documents: [...], folders: [...]}
func (t *ViewTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Validate and extract path
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "path"}), nil
	}

	// Normalize path (trim whitespace, ensure it starts with /)
	path = strings.TrimSpace(path)
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	// Special case: root folder
	if path == "/" {
		return t.listFolderContents(ctx, nil, "/")
	}

	// Try to get as document first (using service layer)
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
	if err == nil {
		// Found a document - path is already computed by service
		return t.formatDocument(doc)
	}

	// If not found as document, try as folder
	if !errors.Is(err, domain.ErrNotFound) {
		// Unexpected error
		return nil, fmt.Errorf("failed to resolve path: %w", err)
	}

	// Try to resolve as folder
	folderID, folderPath, err := t.pathResolver.ResolveFolderPath(ctx, path)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrNotFound, "Path not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to resolve folder path: %w", err)
	}

	// List folder contents (using service layer)
	return t.listFolderContents(ctx, folderID, folderPath)
}

// formatDocument converts a document to the tool result format.
// Note: doc.Path is expected to be already computed by the service layer.
func (t *ViewTool) formatDocument(doc *docsystem.Document) (interface{}, error) {
	// AI sees ai_version if it exists (includes AI's pending suggestions)
	// Otherwise sees user's content
	content := doc.Content
	if doc.AIVersion != nil {
		content = *doc.AIVersion
	}
	wasTruncated := false

	// Truncate content if too large
	if len(content) > t.config.MaxContentSize {
		content = content[:t.config.MaxContentSize] + "\n\n[Content truncated - too large to display fully]"
		wasTruncated = true
	}

	return map[string]interface{}{
		"type":          "document",
		"id":            doc.ID,
		"name":          doc.Name,
		"path":          doc.Path, // Path already computed by service
		"content":       content,
		"word_count":    doc.WordCount(),
		"was_truncated": wasTruncated,
	}, nil
}

// listFolderContents lists documents and subfolders in a folder.
// Uses FolderService.ListChildren which returns both folders and documents.
func (t *ViewTool) listFolderContents(ctx context.Context, folderID *string, folderPath string) (interface{}, error) {
	// Get folder contents using service layer (returns both folders and documents)
	contents, err := t.folderSvc.ListChildren(ctx, t.userID, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder contents: %w", err)
	}

	// Format documents (metadata only, no content)
	docList := make([]map[string]interface{}, len(contents.Documents))
	for i, doc := range contents.Documents {
		docList[i] = map[string]interface{}{
			"id":         doc.ID,
			"name":       doc.Name,
			"word_count": doc.WordCount(),
			"updated_at": doc.UpdatedAt,
		}
	}

	// Format folders
	folderList := make([]map[string]interface{}, len(contents.Folders))
	for i, folder := range contents.Folders {
		folderList[i] = map[string]interface{}{
			"id":   folder.ID,
			"name": folder.Name,
		}
	}

	return map[string]interface{}{
		"type":      "folder",
		"path":      folderPath,
		"documents": docList,
		"folders":   folderList,
	}, nil
}
