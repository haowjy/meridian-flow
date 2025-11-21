package tools

import (
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
)

// RegisterReadOnlyTools creates and registers the read-only document tools
// (doc_view, doc_tree, doc_search) with the provided registry using project-specific context.
//
// This function should be called per-request to create a fresh set of tool instances
// with the correct project_id context.
//
// Parameters:
//   - registry: The ToolRegistry to register tools with
//   - projectID: The project ID for scoping tool access
//   - documentRepo: Repository for document operations
//   - folderRepo: Repository for folder operations
func RegisterReadOnlyTools(
	registry *ToolRegistry,
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) {
	// Create project-specific tool instances
	viewTool := NewViewTool(projectID, documentRepo, folderRepo)
	treeTool := NewTreeTool(projectID, documentRepo, folderRepo)
	searchTool := NewSearchTool(projectID, documentRepo, folderRepo)

	// Register with names matching tool definitions
	registry.Register("doc_view", viewTool)
	registry.Register("doc_tree", treeTool)
	registry.Register("doc_search", searchTool)
}
