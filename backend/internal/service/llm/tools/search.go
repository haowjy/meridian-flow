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

// SearchTool implements the 'search' tool for full-text search across documents.
type SearchTool struct {
	projectID    string
	documentRepo docsystemRepo.DocumentRepository
	folderRepo   docsystemRepo.FolderRepository
}

// NewSearchTool creates a new SearchTool instance.
func NewSearchTool(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) *SearchTool {
	return &SearchTool{
		projectID:    projectID,
		documentRepo: documentRepo,
		folderRepo:   folderRepo,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - query (string, required): Search query (keywords or phrases)
//   - folder (string, optional): Limit search to this folder path
//
// Returns:
//   - {results: [...], count: N, has_more: bool}
func (t *SearchTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Validate and extract query
	query, ok := input["query"].(string)
	if !ok || strings.TrimSpace(query) == "" {
		return nil, errors.New("missing required parameter: query (string)")
	}

	query = strings.TrimSpace(query)

	// Extract optional folder parameter
	var folderID *string
	if folderPathVal, exists := input["folder"]; exists {
		if folderPath, ok := folderPathVal.(string); ok && folderPath != "" {
			// Resolve folder path to folder ID
			resolvedID, _, err := t.resolveFolderPath(ctx, folderPath)
			if err != nil {
				if errors.Is(err, domain.ErrNotFound) {
					return nil, fmt.Errorf("folder not found: %s", folderPath)
				}
				return nil, fmt.Errorf("failed to resolve folder path: %w", err)
			}
			folderID = resolvedID
		}
	}

	// Build search options
	searchOpts := &docsystem.SearchOptions{
		Query:     query,
		ProjectID: t.projectID,
		Limit:     20, // Return top 20 results
		Offset:    0,
		FolderID:  folderID,
	}

	// Apply defaults and validate
	searchOpts.ApplyDefaults()
	if err := searchOpts.Validate(); err != nil {
		return nil, fmt.Errorf("invalid search options: %w", err)
	}

	// Execute search
	results, err := t.documentRepo.SearchDocuments(ctx, searchOpts)
	if err != nil {
		return nil, fmt.Errorf("search failed: %w", err)
	}

	// Format results (metadata only, no full content)
	resultList := make([]map[string]interface{}, len(results.Results))
	for i, result := range results.Results {
		// Extract preview from content (first 200 characters)
		preview := result.Document.Content
		if len(preview) > 200 {
			preview = preview[:200] + "..."
		}

		resultList[i] = map[string]interface{}{
			"id":         result.Document.ID,
			"name":       result.Document.Name,
			"path":       result.Document.Path,
			"score":      result.Score,
			"word_count": result.Document.WordCount,
			"updated_at": result.Document.UpdatedAt,
			"preview":    preview,
		}
	}

	return map[string]interface{}{
		"results":  resultList,
		"count":    results.TotalCount,
		"has_more": results.HasMore,
		"limit":    results.Limit,
		"offset":   results.Offset,
	}, nil
}

// resolveFolderPath walks a path to find the corresponding folder ID.
// Returns the folder ID and the resolved path.
func (t *SearchTool) resolveFolderPath(ctx context.Context, path string) (*string, string, error) {
	// Normalize path
	path = strings.Trim(path, "/")
	if path == "" {
		return nil, "/", nil // Root folder
	}

	// Parse path into segments
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
func (t *SearchTool) findFolderByName(ctx context.Context, parentID *string, name string) (*docsystem.Folder, error) {
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
