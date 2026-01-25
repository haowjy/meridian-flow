package tools

import (
	docsysSvc "meridian/internal/domain/services/docsystem"
	skillSvc "meridian/internal/domain/services/skill"
	"meridian/internal/service/llm/tools/external"
)

// Note: All tools now use service layer exclusively (Phase 4 complete).
// No repository dependencies remain in the tools package.

// ToolRegistryBuilder provides a fluent API for building tool registries.
// This follows the Builder pattern and adheres to the Open/Closed Principle:
// - Open for extension: Easy to add new tool types
// - Closed for modification: Existing registration logic doesn't change
type ToolRegistryBuilder struct {
	registry     *ToolRegistry
	config       *ToolConfig
	namespaceSvc docsysSvc.NamespaceService // Optional, for namespace-aware tools
}

// NewToolRegistryBuilder creates a new builder with a fresh registry.
func NewToolRegistryBuilder() *ToolRegistryBuilder {
	return &ToolRegistryBuilder{
		registry: NewToolRegistry(),
		config:   DefaultToolConfig(),
	}
}

// WithConfig sets custom tool configuration.
// If not called, defaults will be used.
func (b *ToolRegistryBuilder) WithConfig(config *ToolConfig) *ToolRegistryBuilder {
	if config != nil {
		b.config = config
	}
	return b
}

// WithNamespaceService sets the namespace service for namespace-aware tools.
// This enables /.meridian/** path routing and access control.
func (b *ToolRegistryBuilder) WithNamespaceService(namespaceSvc docsysSvc.NamespaceService) *ToolRegistryBuilder {
	b.namespaceSvc = namespaceSvc
	return b
}

// WithDocumentTools registers all document-related tools (doc_view, doc_search, doc_tree, doc_edit).
// These tools operate on the project's document system.
// All tools use services for data access (SOLID: DIP - depends on interfaces).
func (b *ToolRegistryBuilder) WithDocumentTools(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
) *ToolRegistryBuilder {
	// All tools use service layer for data access (Phase 4: zero repo dependencies)
	viewTool := NewViewTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config)
	treeTool := NewTreeTool(projectID, userID, folderSvc, b.namespaceSvc, b.config)
	searchTool := NewSearchTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config)
	editTool := NewEditTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config)

	b.registry.Register("doc_view", viewTool)
	b.registry.Register("doc_tree", treeTool)
	b.registry.Register("doc_search", searchTool)
	b.registry.Register("doc_edit", editTool)

	return b
}

// WithWebSearch registers the web_search tool using an external search client.
// Only registers if a valid client is provided.
func (b *ToolRegistryBuilder) WithWebSearch(client external.SearchClient) *ToolRegistryBuilder {
	if client != nil {
		webSearchTool := NewWebSearchTool(client, b.config)
		b.registry.Register("web_search", webSearchTool)
	}
	return b
}

// WithSkillTools registers skill-related tools (skill_invoke, skill_list).
// Only registers if a valid skill service is provided.
func (b *ToolRegistryBuilder) WithSkillTools(
	projectID string,
	userID string,
	skillService skillSvc.ProjectSkillService,
	isUserInvocation bool,
) *ToolRegistryBuilder {
	if skillService != nil {
		invokeTool := NewSkillInvokeTool(projectID, userID, skillService, isUserInvocation, b.config)
		listTool := NewSkillListTool(projectID, userID, skillService, b.config)

		b.registry.Register("skill_invoke", invokeTool)
		b.registry.Register("skill_list", listTool)
	}
	return b
}

// Build returns the constructed tool registry.
func (b *ToolRegistryBuilder) Build() *ToolRegistry {
	return b.registry
}

// BuildWithDefaults is a convenience method that builds a registry with default document tools.
// Equivalent to: NewToolRegistryBuilder().WithDocumentTools(...).Build()
func BuildWithDefaults(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithNamespaceService(namespaceSvc).
		WithDocumentTools(projectID, userID, documentSvc, folderSvc).
		Build()
}

// BuildWithWebSearch is a convenience method for document tools + web search.
// Equivalent to: NewToolRegistryBuilder().WithDocumentTools(...).WithWebSearch(...).Build()
func BuildWithWebSearch(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
	searchClient external.SearchClient,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithNamespaceService(namespaceSvc).
		WithDocumentTools(projectID, userID, documentSvc, folderSvc).
		WithWebSearch(searchClient).
		Build()
}
