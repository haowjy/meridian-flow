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
// DEPRECATED: Consider using ToolRegistryBuilder for more flexibility.
// This function is maintained for backward compatibility.
//
// Parameters:
//   - registry: The ToolRegistry to register tools with
//   - projectID: The project ID for scoping tool access
//   - documentRepo: Repository for document operations
//   - folderRepo: Repository for folder operations
//   - config: Tool configuration (uses defaults if nil)
func RegisterReadOnlyTools(
	registry *ToolRegistry,
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
	config *ToolConfig,
) {
	// Use builder internally for consistency
	builder := &ToolRegistryBuilder{
		registry: registry,
		config:   config,
	}
	if builder.config == nil {
		builder.config = DefaultToolConfig()
	}

	builder.WithDocumentTools(projectID, documentRepo, folderRepo)
}
