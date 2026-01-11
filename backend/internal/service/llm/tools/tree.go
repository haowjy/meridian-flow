package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/domain"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// TreeTool implements the 'tree' tool for showing hierarchical structure of folders and documents.
// Uses service layer for all data access (SOLID: DIP - depends on interfaces).
type TreeTool struct {
	projectID    string
	userID       string                     // Required for service layer authorization
	folderSvc    docsysSvc.FolderService    // For folder and document listing (replaces documentRepo + folderRepo)
	pathResolver *PathResolver              // For folder path resolution
	config       *ToolConfig
}

// NewTreeTool creates a new TreeTool instance.
// Uses service interfaces for all data access (SOLID: DIP - depends on interfaces, not concretions).
func NewTreeTool(
	projectID string,
	userID string,
	folderSvc docsysSvc.FolderService,
	config *ToolConfig,
) *TreeTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &TreeTool{
		projectID:    projectID,
		userID:       userID,
		folderSvc:    folderSvc,
		pathResolver: NewPathResolver(projectID, userID, folderSvc),
		config:       config,
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
	// Extract folder path (default to root)
	folderPath := "/" // default
	if folderVal, exists := input["folder"]; exists {
		if fp, ok := folderVal.(string); ok && strings.TrimSpace(fp) != "" {
			folderPath = strings.TrimSpace(fp)
		}
	}

	// Normalize path
	if folderPath == "" {
		folderPath = "/"
	}
	if !strings.HasPrefix(folderPath, "/") {
		folderPath = "/" + folderPath
	}

	// Extract and validate depth (JSON numbers are float64)
	depth := t.config.TreeDefaultDepth
	if depthVal, exists := input["depth"]; exists {
		depthFloat, ok := depthVal.(float64)
		if !ok {
			return ErrorResult(ErrInvalidInput, "Invalid input", map[string]any{"param": "depth", "expected": "number"}), nil
		}
		depth = int(depthFloat)
	}

	// Validate depth
	if depth < 1 {
		depth = 1
	}
	if depth > t.config.TreeMaxDepth {
		depth = t.config.TreeMaxDepth
	}

	// Resolve folder path to folder ID
	var folderID *string
	resolvedPath := folderPath

	if folderPath != "/" {
		// Use PathResolver to resolve folder path
		resolvedID, resolvedPathStr, err := t.pathResolver.ResolveFolderPath(ctx, folderPath)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return ErrorResult(ErrNotFound, "Folder not found", map[string]any{"path": folderPath}), nil
			}
			return nil, fmt.Errorf("failed to resolve folder path: %w", err)
		}
		folderID = resolvedID
		resolvedPath = resolvedPathStr
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
// Uses FolderService.ListChildren which returns both folders and documents.
func (t *TreeTool) buildTree(ctx context.Context, folderID *string, maxDepth, currentDepth int) (map[string]interface{}, error) {
	if currentDepth >= maxDepth {
		// Reached max depth, don't traverse deeper
		return map[string]interface{}{
			"folders":   []map[string]interface{}{},
			"documents": []map[string]interface{}{},
		}, nil
	}

	// Get folder contents using service layer (returns both folders and documents)
	contents, err := t.folderSvc.ListChildren(ctx, t.userID, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder contents: %w", err)
	}

	// Format folders (with recursive subtrees if within depth limit)
	folderList := make([]map[string]interface{}, len(contents.Folders))
	for i, folder := range contents.Folders {
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

	// Format documents (metadata only, with full filename including extension)
	docList := make([]map[string]interface{}, len(contents.Documents))
	for i, doc := range contents.Documents {
		docList[i] = map[string]interface{}{
			"id":         doc.ID,
			"name":       doc.Filename(),  // Full filename with extension (e.g., "README.md")
			"extension":  doc.Extension,   // Extension only (e.g., ".md") for format detection
			"word_count": doc.WordCount(),
			"updated_at": doc.UpdatedAt,
		}
	}

	return map[string]interface{}{
		"folders":   folderList,
		"documents": docList,
	}, nil
}
