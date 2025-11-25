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
	pathResolver *PathResolver
	config       *ToolConfig
}

// NewSearchTool creates a new SearchTool instance.
func NewSearchTool(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
	config *ToolConfig,
) *SearchTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SearchTool{
		projectID:    projectID,
		documentRepo: documentRepo,
		pathResolver: NewPathResolver(projectID, folderRepo),
		config:       config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - query (string, required): Search query (keywords or phrases)
//   - folder (string, optional): Limit search to this folder path
//   - limit (integer, optional): Maximum results to return (default: 5, max: 20)
//   - offset (integer, optional): Number of results to skip (default: 0)
//
// Returns:
//   - {results: [...], total_count: N, has_more: bool}
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
			resolvedID, _, err := t.pathResolver.ResolveFolderPath(ctx, folderPath)
			if err != nil {
				if errors.Is(err, domain.ErrNotFound) {
					return nil, fmt.Errorf("folder not found: %s", folderPath)
				}
				return nil, fmt.Errorf("failed to resolve folder path: %w", err)
			}
			folderID = resolvedID
		}
	}

	// Extract optional limit parameter
	limit := t.config.SearchDefaultLimit
	if limitVal, exists := input["limit"]; exists {
		if limitFloat, ok := limitVal.(float64); ok {
			limit = int(limitFloat)
			if limit < 1 {
				limit = 1
			} else if limit > t.config.SearchMaxLimit {
				limit = t.config.SearchMaxLimit
			}
		}
	}

	// Extract optional offset parameter (default: 0)
	offset := 0
	if offsetVal, exists := input["offset"]; exists {
		if offsetFloat, ok := offsetVal.(float64); ok {
			offset = int(offsetFloat)
			if offset < 0 {
				offset = 0
			}
		}
	}

	// Build search options
	searchOpts := &docsystem.SearchOptions{
		Query:     query,
		ProjectID: t.projectID,
		Limit:     limit,
		Offset:    offset,
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
		"results":     resultList,
		"total_count": results.TotalCount,
		"has_more":    results.HasMore,
	}, nil
}
