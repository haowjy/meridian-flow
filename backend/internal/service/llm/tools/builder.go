package tools

import (
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
	"meridian/internal/service/llm/tools/external"
)

// ToolRegistryBuilder provides a fluent API for building tool registries.
// This follows the Builder pattern and adheres to the Open/Closed Principle:
// - Open for extension: Easy to add new tool types
// - Closed for modification: Existing registration logic doesn't change
type ToolRegistryBuilder struct {
	registry *ToolRegistry
	config   *ToolConfig
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

// WithDocumentTools registers all document-related tools (doc_view, doc_search, doc_tree, doc_edit).
// These tools operate on the project's document system.
func (b *ToolRegistryBuilder) WithDocumentTools(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) *ToolRegistryBuilder {
	viewTool := NewViewTool(projectID, documentRepo, folderRepo, b.config)
	treeTool := NewTreeTool(projectID, documentRepo, folderRepo, b.config)
	searchTool := NewSearchTool(projectID, documentRepo, folderRepo, b.config)
	editTool := NewEditTool(projectID, documentRepo, folderRepo, b.config)

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

// Build returns the constructed tool registry.
func (b *ToolRegistryBuilder) Build() *ToolRegistry {
	return b.registry
}

// BuildWithDefaults is a convenience method that builds a registry with default document tools.
// Equivalent to: NewToolRegistryBuilder().WithDocumentTools(...).Build()
func BuildWithDefaults(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithDocumentTools(projectID, documentRepo, folderRepo).
		Build()
}

// BuildWithWebSearch is a convenience method for document tools + web search.
// Equivalent to: NewToolRegistryBuilder().WithDocumentTools(...).WithWebSearch(...).Build()
func BuildWithWebSearch(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
	searchClient external.SearchClient,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithDocumentTools(projectID, documentRepo, folderRepo).
		WithWebSearch(searchClient).
		Build()
}
