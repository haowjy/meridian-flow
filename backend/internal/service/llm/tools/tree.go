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

// TreeTool implements the 'tree' tool for showing hierarchical structure of folders and documents.
type TreeTool struct {
	projectID    string
	documentRepo docsystemRepo.DocumentRepository
	folderRepo   docsystemRepo.FolderRepository
}

// NewTreeTool creates a new TreeTool instance.
func NewTreeTool(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) *TreeTool {
	return &TreeTool{
		projectID:    projectID,
		documentRepo: documentRepo,
		folderRepo:   folderRepo,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - folder (string, required): Unix-style path to folder
//   - depth (number, optional, default: 2, max: 5): How many levels deep to traverse
//
// Returns:
//   - {type: "tree", path, folders: [...], documents: [...]}
func (t *TreeTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Validate and extract folder path
	folderPath, ok := input["folder"].(string)
	if !ok || folderPath == "" {
		return nil, errors.New("missing required parameter: folder (string)")
	}

	// Normalize path
	folderPath = strings.TrimSpace(folderPath)
	if folderPath == "" {
		folderPath = "/"
	}
	if !strings.HasPrefix(folderPath, "/") {
		folderPath = "/" + folderPath
	}

	// Extract and validate depth (JSON numbers are float64)
	depth := 2 // default
	if depthVal, exists := input["depth"]; exists {
		depthFloat, ok := depthVal.(float64)
		if !ok {
			return nil, errors.New("depth must be a number")
		}
		depth = int(depthFloat)
	}

	// Validate depth
	if depth < 1 {
		depth = 1
	}
	if depth > 5 {
		depth = 5 // max depth limit
	}

	// Resolve folder path to folder ID
	var folderID *string
	resolvedPath := folderPath

	if folderPath != "/" {
		// Parse path into segments
		pathSegments := strings.Split(strings.Trim(folderPath, "/"), "/")
		var currentFolderID *string

		// Walk the path to find the target folder
		for _, segment := range pathSegments {
			segment = strings.TrimSpace(segment)
			if segment == "" {
				continue
			}

			folder, err := t.findFolderByName(ctx, currentFolderID, segment)
			if err != nil {
				if errors.Is(err, domain.ErrNotFound) {
					return nil, fmt.Errorf("folder not found: %s", folderPath)
				}
				return nil, fmt.Errorf("failed to resolve folder path: %w", err)
			}

			currentFolderID = &folder.ID
		}

		folderID = currentFolderID
	}

	// Build tree starting from this folder
	tree, err := t.buildTree(ctx, folderID, depth, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to build tree: %w", err)
	}

	// Add metadata
	tree["type"] = "tree"
	tree["path"] = resolvedPath
	tree["depth"] = depth

	return tree, nil
}

// buildTree recursively builds the tree structure up to the specified depth.
func (t *TreeTool) buildTree(ctx context.Context, folderID *string, maxDepth, currentDepth int) (map[string]interface{}, error) {
	if currentDepth >= maxDepth {
		// Reached max depth, don't traverse deeper
		return map[string]interface{}{
			"folders":   []map[string]interface{}{},
			"documents": []map[string]interface{}{},
		}, nil
	}

	// Get child folders
	folders, err := t.folderRepo.ListChildren(ctx, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folders: %w", err)
	}

	// Get documents in this folder
	documents, err := t.documentRepo.ListByFolder(ctx, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list documents: %w", err)
	}

	// Format folders (with recursive subtrees if within depth limit)
	folderList := make([]map[string]interface{}, len(folders))
	for i, folder := range folders {
		// Recursively build subtree for this folder
		subtree, err := t.buildTree(ctx, &folder.ID, maxDepth, currentDepth+1)
		if err != nil {
			return nil, err
		}

		folderList[i] = map[string]interface{}{
			"id":        folder.ID,
			"name":      folder.Name,
			"folders":   subtree["folders"],
			"documents": subtree["documents"],
		}
	}

	// Format documents (metadata only)
	docList := make([]map[string]interface{}, len(documents))
	for i, doc := range documents {
		docList[i] = map[string]interface{}{
			"id":         doc.ID,
			"name":       doc.Name,
			"word_count": doc.WordCount,
			"updated_at": doc.UpdatedAt,
		}
	}

	return map[string]interface{}{
		"folders":   folderList,
		"documents": docList,
	}, nil
}

// findFolderByName finds a folder by name within a parent folder.
func (t *TreeTool) findFolderByName(ctx context.Context, parentID *string, name string) (*docsystem.Folder, error) {
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
