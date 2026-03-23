package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
)

// SearchToolMetadata returns metadata for the doc_search tool.
// This enables OCP compliance - tool self-describes for system prompt generation.
func SearchToolMetadata() *ToolMetadata {
	return &ToolMetadata{
		Name:        "doc_search",
		Description: "Search across all documents by content",
		Guideline:   "When the user asks about their project, search or read relevant documents",
	}
}

// SearchTool implements the 'search' tool for full-text search across documents.
// Uses service layer for all data access (SOLID: DIP - depends on interfaces).
// Access to /.meridian/** is DENIED - skills are not searchable via doc tools.
type SearchTool struct {
	projectID    string
	userID       string                        // Required for service layer authorization
	documentSvc  domaindocsys.DocumentService  // For search operations (replaces documentRepo)
	namespaceSvc domaindocsys.NamespaceService // For namespace routing (optional)
	pathResolver *DocumentPathResolver         // For folder path resolution
	config       *ToolConfig
}

// NewSearchTool creates a new SearchTool instance.
// Uses service interfaces for all data access (SOLID: DIP - depends on interfaces, not concretions).
func NewSearchTool(
	projectID string,
	userID string,
	documentSvc domaindocsys.DocumentService,
	folderSvc domaindocsys.FolderService, // For DocumentPathResolver
	namespaceSvc domaindocsys.NamespaceService,
	config *ToolConfig,
) *SearchTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SearchTool{
		projectID:    projectID,
		userID:       userID,
		documentSvc:  documentSvc,
		namespaceSvc: namespaceSvc,
		pathResolver: NewPathResolver(projectID, userID, folderSvc),
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
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "query"}), nil
	}

	query = strings.TrimSpace(query)

	// Extract optional folder parameter
	var folderID *string
	if folderPathVal, exists := input["folder"]; exists {
		if folderPath, ok := folderPathVal.(string); ok && folderPath != "" {
			// Check namespace access - doc_search DENIED for /.meridian/**
			if t.namespaceSvc != nil {
				namespace, _, err := t.namespaceSvc.ParsePath(folderPath)
				if err == nil && namespace == domaindocsys.NamespaceMeridian {
					return ErrorResult(ErrInvalidInput, "doc_search cannot access /.meridian/ paths - skills are not searchable", map[string]any{
						"path": folderPath,
					}), nil
				}
				if err == nil && namespace == domaindocsys.NamespaceSession {
					return ErrorResult(ErrInvalidInput, "doc_search cannot access /.session/ paths", map[string]any{
						"path": folderPath,
					}), nil
				}
			}

			// Resolve folder path to folder ID
			resolvedID, _, err := t.pathResolver.ResolveFolderPath(ctx, folderPath)
			if err != nil {
				if errors.Is(err, domain.ErrNotFound) {
					return ErrorResult(ErrNotFound, "folder not found", map[string]any{"path": folderPath}), nil
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

	// Build search request for service layer
	searchReq := &domaindocsys.SearchDocumentsRequest{
		Query:     query,
		ProjectID: t.projectID,
		Limit:     limit,
		Offset:    offset,
		FolderID:  folderID,
	}

	// Execute search using service layer (handles authorization + path computation)
	results, err := t.documentSvc.SearchDocuments(ctx, t.userID, searchReq)
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
			"name":       result.Document.Filename(),
			"path":       result.Document.Path,
			"score":      result.Score,
			"word_count": result.Document.WordCount(),
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
