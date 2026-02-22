package tools

import (
	collabSvc "meridian/internal/domain/services/collab"
	skillModels "meridian/internal/domain/models/skill"
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
	registry         *ToolRegistry
	config           *ToolConfig
	namespaceSvc     docsysSvc.NamespaceService  // Optional, for namespace-aware tools
	mutationStrategy DocumentMutationStrategy    // Optional, for AI edit persistence strategy
	aiContentReader  collabSvc.AIContentReader   // Optional, for reading ai_content in text editor
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

// WithMutationStrategy sets the strategy for persisting AI edits.
// Must be called — panics at tool construction time if nil.
func (b *ToolRegistryBuilder) WithMutationStrategy(strategy DocumentMutationStrategy) *ToolRegistryBuilder {
	b.mutationStrategy = strategy
	return b
}

// WithAIContentReader sets the reader for projected AI content.
// When set, str_replace/insert/view read ai_content instead of stale doc.Content,
// so each tool call in a multi-tool turn sees prior edits.
func (b *ToolRegistryBuilder) WithAIContentReader(reader collabSvc.AIContentReader) *ToolRegistryBuilder {
	b.aiContentReader = reader
	return b
}

// WithDocumentTools registers all document-related tools (str_replace_based_edit_tool, doc_search).
// These tools operate on the project's document system.
// All tools use services for data access (SOLID: DIP - depends on interfaces).
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
//
// The str_replace_based_edit_tool is a unified tool that combines view and edit operations,
// matching Anthropic's text_editor_20250728 API for seamless provider mapping.
// Folder viewing is handled by str_replace_based_edit_tool's "view" command on folder paths.
func (b *ToolRegistryBuilder) WithDocumentTools(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
) *ToolRegistryBuilder {
	// All tools use service layer for data access (Phase 4: zero repo dependencies)
	// Tools self-describe via metadata for system prompt generation (OCP compliance)
	textEditorTool := NewTextEditorTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config, b.mutationStrategy, b.aiContentReader)
	searchTool := NewSearchTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config)

	b.registry.RegisterWithMetadata("str_replace_based_edit_tool", textEditorTool, TextEditorToolMetadata())
	b.registry.RegisterWithMetadata("doc_search", searchTool, SearchToolMetadata())

	return b
}

// WithEnabledDocumentTools registers only the specified document tools.
// enabledTools is the list of tool names to register (e.g., ["str_replace_based_edit_tool", "doc_search"]).
// This allows frontend to control which tools the LLM can use.
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithEnabledDocumentTools(
	enabledTools []string,
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
) *ToolRegistryBuilder {
	// Build set of enabled tools for O(1) lookup
	toolSet := make(map[string]bool)
	for _, t := range enabledTools {
		toolSet[t] = true
	}

	if toolSet["str_replace_based_edit_tool"] {
		textEditorTool := NewTextEditorTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config, b.mutationStrategy, b.aiContentReader)
		b.registry.RegisterWithMetadata("str_replace_based_edit_tool", textEditorTool, TextEditorToolMetadata())
	}

	if toolSet["doc_search"] {
		searchTool := NewSearchTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config)
		b.registry.RegisterWithMetadata("doc_search", searchTool, SearchToolMetadata())
	}

	return b
}

// WithWebSearch registers the web_search tool using an external search client.
// Only registers if a valid client is provided.
// Tool is registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithWebSearch(client external.SearchClient) *ToolRegistryBuilder {
	if client != nil {
		webSearchTool := NewWebSearchTool(client, b.config)
		b.registry.RegisterWithMetadata("web_search", webSearchTool, WebSearchToolMetadata())
	}
	return b
}

// WithSkillTools registers skill-related tools (skill_invoke, skill_list).
// Only registers if a valid skill service is provided.
// availableSkills is used to enrich skill_invoke metadata with the list of available skills,
// so the system prompt includes skill names/descriptions only when tools are actually registered.
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithSkillTools(
	projectID string,
	userID string,
	skillService skillSvc.ProjectSkillService,
	isUserInvocation bool,
	availableSkills []*skillModels.ProjectSkill,
) *ToolRegistryBuilder {
	if skillService != nil {
		invokeTool := NewSkillInvokeTool(projectID, userID, skillService, isUserInvocation, b.config)
		listTool := NewSkillListTool(projectID, userID, skillService, b.config)

		// Enrich skill_invoke metadata with available skills list (runtime context)
		invokeMetadata := SkillInvokeToolMetadata()
		invokeMetadata.Guideline = BuildSkillInvokeGuideline(availableSkills)

		b.registry.RegisterWithMetadata("skill_invoke", invokeTool, invokeMetadata)
		b.registry.RegisterWithMetadata("skill_list", listTool, SkillListToolMetadata())
	}
	return b
}

// WithEnabledSkillTools registers only the specified skill tools.
// enabledTools is the list of tool names to register (e.g., ["skill_invoke"]).
// availableSkills is used to enrich skill_invoke metadata with the list of available skills.
// This allows frontend to control which tools the LLM can use.
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithEnabledSkillTools(
	enabledTools []string,
	projectID string,
	userID string,
	skillService skillSvc.ProjectSkillService,
	isUserInvocation bool,
	availableSkills []*skillModels.ProjectSkill,
) *ToolRegistryBuilder {
	if skillService == nil {
		return b
	}

	// Build set of enabled tools for O(1) lookup
	toolSet := make(map[string]bool)
	for _, t := range enabledTools {
		toolSet[t] = true
	}

	// Register only enabled skill tools with metadata (OCP compliance)
	if toolSet["skill_invoke"] {
		invokeTool := NewSkillInvokeTool(projectID, userID, skillService, isUserInvocation, b.config)
		// Enrich skill_invoke metadata with available skills list (runtime context)
		invokeMetadata := SkillInvokeToolMetadata()
		invokeMetadata.Guideline = BuildSkillInvokeGuideline(availableSkills)
		b.registry.RegisterWithMetadata("skill_invoke", invokeTool, invokeMetadata)
	}
	if toolSet["skill_list"] {
		listTool := NewSkillListTool(projectID, userID, skillService, b.config)
		b.registry.RegisterWithMetadata("skill_list", listTool, SkillListToolMetadata())
	}

	return b
}

// Build returns the constructed tool registry.
func (b *ToolRegistryBuilder) Build() *ToolRegistry {
	return b.registry
}

// BuildWithDefaults is a convenience method that builds a registry with default document tools.
// Equivalent to: NewToolRegistryBuilder().WithMutationStrategy(...).WithDocumentTools(...).Build()
func BuildWithDefaults(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
	mutationStrategy DocumentMutationStrategy,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithNamespaceService(namespaceSvc).
		WithMutationStrategy(mutationStrategy).
		WithDocumentTools(projectID, userID, documentSvc, folderSvc).
		Build()
}

// BuildWithWebSearch is a convenience method for document tools + web search.
// Equivalent to: NewToolRegistryBuilder().WithMutationStrategy(...).WithDocumentTools(...).WithWebSearch(...).Build()
func BuildWithWebSearch(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
	mutationStrategy DocumentMutationStrategy,
	searchClient external.SearchClient,
) *ToolRegistry {
	return NewToolRegistryBuilder().
		WithNamespaceService(namespaceSvc).
		WithMutationStrategy(mutationStrategy).
		WithDocumentTools(projectID, userID, documentSvc, folderSvc).
		WithWebSearch(searchClient).
		Build()
}
