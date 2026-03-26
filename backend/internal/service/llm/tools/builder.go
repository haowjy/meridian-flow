package tools

import (
	domaindocsys "meridian/internal/domain/docsystem"
	skill "meridian/internal/domain/skill"
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
	namespaceSvc     domaindocsys.NamespaceService // Optional, for namespace-aware tools
	mutationStrategy DocumentMutationStrategy      // Optional, for AI edit persistence strategy
}

// NewToolRegistryBuilder creates a new builder with a fresh registry.
func NewToolRegistryBuilder() *ToolRegistryBuilder {
	return &ToolRegistryBuilder{
		registry: NewToolRegistry(),
		config:   DefaultToolConfig(),
	}
}

// WithNamespaceService sets the namespace service for namespace-aware tools.
// This enables /.meridian/** path routing and access control.
func (b *ToolRegistryBuilder) WithNamespaceService(namespaceSvc domaindocsys.NamespaceService) *ToolRegistryBuilder {
	b.namespaceSvc = namespaceSvc
	return b
}

// WithMutationStrategy sets the strategy for persisting AI edits.
// Must be called — panics at tool construction time if nil.
func (b *ToolRegistryBuilder) WithMutationStrategy(strategy DocumentMutationStrategy) *ToolRegistryBuilder {
	b.mutationStrategy = strategy
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
	documentSvc domaindocsys.DocumentService,
	folderSvc domaindocsys.FolderService,
) *ToolRegistryBuilder {
	// Build set of enabled tools for O(1) lookup
	toolSet := make(map[string]bool)
	for _, t := range enabledTools {
		toolSet[t] = true
	}

	if toolSet["str_replace_based_edit_tool"] {
		textEditorTool := NewTextEditorTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config, b.mutationStrategy)
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

// WithEnabledSkillTools registers only the specified skill tools.
// enabledTools is the list of tool names to register (e.g., ["skill_invoke"]).
// availableSkills is used to enrich skill_invoke metadata with the list of available skills.
// This allows frontend to control which tools the LLM can use.
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithEnabledSkillTools(
	enabledTools []string,
	projectID string,
	userID string,
	skillService skill.ProjectSkillService,
	isUserInvocation bool,
	availableSkills []*skill.ProjectSkill,
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
