package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
)

// ViewTool implements the 'view' tool for reading document content or listing folder contents.
type ViewTool struct {
	projectID      string
	documentRepo   docsystemRepo.DocumentRepository
	folderRepo     docsystemRepo.FolderRepository
	maxContentSize int // Maximum content size to return (prevents token overflow)
}

// NewViewTool creates a new ViewTool instance.
func NewViewTool(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) *ViewTool {
	return &ViewTool{
		projectID:      projectID,
		documentRepo:   documentRepo,
		folderRepo:     folderRepo,
		maxContentSize: 20000, // 20k characters (~5k tokens)
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
		return nil, errors.New("missing required parameter: path (string)")
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

	// Try to get as document first
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err == nil {
		// Found a document
		return t.formatDocument(ctx, doc)
	}

	// If not found as document, try as folder
	if !errors.Is(err, domain.ErrNotFound) {
		// Unexpected error
		return nil, fmt.Errorf("failed to resolve path: %w", err)
	}

	// Try to resolve as folder
	folderID, folderPath, err := t.resolveFolderPath(ctx, path)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, fmt.Errorf("path not found: %s (tried as both document and folder)", path)
		}
		return nil, fmt.Errorf("failed to resolve folder path: %w", err)
	}

	// List folder contents
	return t.listFolderContents(ctx, folderID, folderPath)
}

// formatDocument converts a document to the tool result format.
func (t *ViewTool) formatDocument(ctx context.Context, doc *docsystem.Document) (interface{}, error) {
	// Compute path for the document
	path, err := t.documentRepo.GetPath(ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("failed to compute document path: %w", err)
	}

	content := doc.Content
	wasTruncated := false

	// Truncate content if too large
	if len(content) > t.maxContentSize {
		content = content[:t.maxContentSize] + "\n\n[Content truncated - too large to display fully]"
		wasTruncated = true
	}

	return map[string]interface{}{
		"type":          "document",
		"id":            doc.ID,
		"name":          doc.Name,
		"path":          path,
		"content":       content,
		"word_count":    doc.WordCount,
		"was_truncated": wasTruncated,
	}, nil
}

// listFolderContents lists documents and subfolders in a folder.
func (t *ViewTool) listFolderContents(ctx context.Context, folderID *string, folderPath string) (interface{}, error) {
	// Get documents in this folder
	documents, err := t.documentRepo.ListByFolder(ctx, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list documents: %w", err)
	}

	// Get child folders
	folders, err := t.folderRepo.ListChildren(ctx, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folders: %w", err)
	}

	// Format documents (metadata only, no content)
	docList := make([]map[string]interface{}, len(documents))
	for i, doc := range documents {
		docList[i] = map[string]interface{}{
			"id":         doc.ID,
			"name":       doc.Name,
			"word_count": doc.WordCount,
			"updated_at": doc.UpdatedAt,
		}
	}

	// Format folders
	folderList := make([]map[string]interface{}, len(folders))
	for i, folder := range folders {
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

// resolveFolderPath walks a path to find the corresponding folder ID.
// Returns the folder ID and the resolved path.
func (t *ViewTool) resolveFolderPath(ctx context.Context, path string) (*string, string, error) {
	// Parse path into segments
	path = strings.Trim(path, "/")
	if path == "" {
		return nil, "/", nil // Root folder
	}

	segments := strings.Split(path, "/")

	// Walk the path segment by segment
	var currentFolderID *string
	currentPath := "/"

	for _, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}

		// Find folder with this name in the current folder
		folder, err := t.findFolderByName(ctx, currentFolderID, segment)
		if err != nil {
			return nil, "", err
		}

		currentFolderID = &folder.ID
		if currentPath == "/" {
			currentPath = "/" + folder.Name
		} else {
			currentPath = currentPath + "/" + folder.Name
		}
	}

	return currentFolderID, currentPath, nil
}

// findFolderByName finds a folder by name within a parent folder.
func (t *ViewTool) findFolderByName(ctx context.Context, parentID *string, name string) (*docsystem.Folder, error) {
	// Get all child folders
	folders, err := t.folderRepo.ListChildren(ctx, parentID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folders: %w", err)
	}

	// Find folder with matching name
	for _, folder := range folders {
		if folder.Name == name {
			return &folder, nil
		}
	}

	return nil, fmt.Errorf("folder '%s': %w", name, domain.ErrNotFound)
}
