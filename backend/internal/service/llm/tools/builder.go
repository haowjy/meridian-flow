package tools

import (
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
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
	workItemSlug     string                        // Optional, for .meridian/work/<slug>/ isolation
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

// WithWorkItemSlug sets the current work item slug for namespace isolation.
// Agents may only write to .meridian/work/<slug>/ when slug matches this value.
// .meridian/fs/ and .agents/ remain accessible regardless of the slug.
// If not set, all .meridian/work/ paths are denied (no active work item context).
func (b *ToolRegistryBuilder) WithWorkItemSlug(slug string) *ToolRegistryBuilder {
	b.workItemSlug = slug
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
		textEditorTool := NewTextEditorTool(projectID, userID, documentSvc, folderSvc, b.namespaceSvc, b.config, b.mutationStrategy, b.workItemSlug)
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

// WithSpawnTool registers the spawn_agent tool when conditions are met.
//
// Guards (either condition → no-op):
//   - spawnInvoker is nil (spawn service not wired yet, e.g. during testing)
//   - workItemID is empty (thread not linked to a work item; spawn would have no parent context)
//
// The tool is registered with metadata for dynamic system prompt generation (OCP compliance).
func (b *ToolRegistryBuilder) WithSpawnTool(
	parentThreadID string,
	workItemID string,
	projectID string,
	userID string,
	spawnInvoker domainllm.SpawnInvoker,
) *ToolRegistryBuilder {
	if spawnInvoker == nil || workItemID == "" {
		return b
	}
	spawnTool := NewSpawnAgentTool(parentThreadID, workItemID, projectID, userID, spawnInvoker)
	b.registry.RegisterWithMetadata("spawn_agent", spawnTool, SpawnAgentToolMetadata())
	return b
}

// WithEnabledSkillTools registers only the specified skill tools.
// enabledTools is the list of tool names to register (e.g., ["skill_invoke"]).
// skillResolver is the file-backed resolver for runtime skill data.
// availableSkills is used to enrich skill_invoke metadata with the list of available skills.
// This allows frontend to control which tools the LLM can use.
// Tools are registered with metadata for dynamic system prompt generation (SOLID: OCP compliance).
func (b *ToolRegistryBuilder) WithEnabledSkillTools(
	enabledTools []string,
	projectID string,
	skillResolver domainagents.SkillResolver,
	isUserInvocation bool,
	availableSkills []domainagents.RuntimeSkill,
) *ToolRegistryBuilder {
	if skillResolver == nil {
		return b
	}

	// Build set of enabled tools for O(1) lookup
	toolSet := make(map[string]bool)
	for _, t := range enabledTools {
		toolSet[t] = true
	}

	// Register only enabled skill tools with metadata (OCP compliance)
	if toolSet["skill_invoke"] {
		invokeTool := NewSkillInvokeTool(projectID, skillResolver, isUserInvocation, b.config)
		// Enrich skill_invoke metadata with available skills list (runtime context)
		invokeMetadata := SkillInvokeToolMetadata()
		invokeMetadata.Guideline = BuildSkillInvokeGuideline(availableSkills)
		b.registry.RegisterWithMetadata("skill_invoke", invokeTool, invokeMetadata)
	}
	if toolSet["skill_list"] {
		listTool := NewSkillListTool(projectID, skillResolver, b.config)
		b.registry.RegisterWithMetadata("skill_list", listTool, SkillListToolMetadata())
	}

	return b
}

// WithPersonaToolFilter prunes the set of registered tools based on persona tool policy.
// Must be called AFTER all tool registration is complete.
//
// allowedTools: if non-empty, only these tool names survive; an empty/nil slice means
// "inherit all registered tools" — the allow-list pass is skipped.
// disallowedTools: these names are removed from whatever set survives the allow-list pass.
//
// Calling with both slices empty/nil is a no-op.
func (b *ToolRegistryBuilder) WithPersonaToolFilter(allowedTools, disallowedTools []string) *ToolRegistryBuilder {
	if len(allowedTools) == 0 && len(disallowedTools) == 0 {
		return b
	}

	// Allow-list pass: keep only the explicitly listed tools.
	if len(allowedTools) > 0 {
		allowed := make(map[string]bool, len(allowedTools))
		for _, t := range allowedTools {
			allowed[t] = true
		}
		b.registry.Prune(func(name string) bool {
			return allowed[name]
		})
	}

	// Deny-list pass: remove explicitly disallowed tools from the remaining set.
	if len(disallowedTools) > 0 {
		denied := make(map[string]bool, len(disallowedTools))
		for _, t := range disallowedTools {
			denied[t] = true
		}
		b.registry.Prune(func(name string) bool {
			return !denied[name]
		})
	}

	return b
}

// Build returns the constructed tool registry.
func (b *ToolRegistryBuilder) Build() *ToolRegistry {
	return b.registry
}
