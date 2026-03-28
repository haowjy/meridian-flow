package streaming

import (
	"context"
	"log/slog"

	"github.com/google/uuid"

	"meridian/internal/config"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/pkg/sliceutil"
	"meridian/internal/service/llm/tools"
	"meridian/internal/service/llm/tools/external"
)

// ToolRegistryFactory builds tool registries for both prompt assembly and execution.
// Common builder setup is shared; BuildTempRegistry and BuildProductionRegistry
// add variant-specific tools on top.
type ToolRegistryFactory struct {
	namespaceSvc     domaindocsys.NamespaceService
	mutationStrategy tools.DocumentMutationStrategy
	documentSvc      domaindocsys.DocumentService
	folderSvc        domaindocsys.FolderService
	skillResolver    domainagents.SkillResolver
	spawnInvokerRef  func() domainllm.SpawnInvoker
	config           *config.Config
	logger           *slog.Logger
}

// ToolRegistryFactoryDeps groups dependencies for ToolRegistryFactory.
type ToolRegistryFactoryDeps struct {
	NamespaceSvc     domaindocsys.NamespaceService
	MutationStrategy tools.DocumentMutationStrategy
	DocumentSvc      domaindocsys.DocumentService
	FolderSvc        domaindocsys.FolderService
	SkillResolver    domainagents.SkillResolver
	SpawnInvokerRef  func() domainllm.SpawnInvoker
	Config           *config.Config
	Logger           *slog.Logger
}

// ToolRegistryInputs captures request-scoped context shared by temp and production registries.
type ToolRegistryInputs struct {
	EnabledTools []string
	ProjectID    string
	UserID       string
	WorkItemSlug string
	Persona      *domainagents.Persona
}

// NewToolRegistryFactory creates a ToolRegistryFactory.
func NewToolRegistryFactory(deps ToolRegistryFactoryDeps) *ToolRegistryFactory {
	return &ToolRegistryFactory{
		namespaceSvc:     deps.NamespaceSvc,
		mutationStrategy: deps.MutationStrategy,
		documentSvc:      deps.DocumentSvc,
		folderSvc:        deps.FolderSvc,
		skillResolver:    deps.SkillResolver,
		spawnInvokerRef:  deps.SpawnInvokerRef,
		config:           deps.Config,
		logger:           deps.Logger,
	}
}

// LoadAvailableSkills resolves runtime skills for prompt/tool metadata enrichment.
// This is best-effort by design: failures are logged and an empty slice is returned.
func (f *ToolRegistryFactory) LoadAvailableSkills(ctx context.Context, projectID string) []domainagents.RuntimeSkill {
	projectUUID, err := uuid.Parse(projectID)
	if err != nil {
		f.logger.Warn("failed to parse project UUID for skill loading; skills unavailable",
			"project_id", projectID,
			"error", err,
		)
		return []domainagents.RuntimeSkill{}
	}

	skills, _, err := f.skillResolver.List(ctx, projectUUID)
	if err != nil {
		f.logger.Warn("failed to load skills for tool metadata", "error", err)
		return []domainagents.RuntimeSkill{}
	}

	return skills
}

// BuildTempRegistry builds the prompt-facing registry used for system prompt tool-section generation.
func (f *ToolRegistryFactory) BuildTempRegistry(inputs ToolRegistryInputs, skills []domainagents.RuntimeSkill) *tools.ToolRegistry {
	builder := f.commonBuilder(inputs, skills)

	if inputs.Persona != nil {
		builder.WithPersonaToolFilter(inputs.Persona.Tools, inputs.Persona.DisallowedTools)
	}

	return builder.Build()
}

// BuildProductionRegistry builds the execution registry with spawn + web search tools.
func (f *ToolRegistryFactory) BuildProductionRegistry(
	inputs ToolRegistryInputs,
	skills []domainagents.RuntimeSkill,
	threadID string,
	workItemID string,
) *tools.ToolRegistry {
	var spawnInvoker domainllm.SpawnInvoker
	if f.spawnInvokerRef != nil {
		spawnInvoker = f.spawnInvokerRef()
	}

	builder := f.commonBuilder(inputs, skills).
		WithSpawnTool(threadID, workItemID, inputs.ProjectID, inputs.UserID, spawnInvoker)

	// Add web search tool if requested via provider-specific tool name.
	// Registration must happen before persona filtering so it can also be pruned.
	requestedTools := inputs.EnabledTools
	if sliceutil.Contains(requestedTools, "tavily_web_search") {
		if f.config.LLM.SearchAPIKey != "" {
			searchClient := external.NewTavilyClient(f.config.LLM.SearchAPIKey)
			builder.WithWebSearch(searchClient)

			f.logger.Debug("per-request tool registry created",
				"project_id", inputs.ProjectID,
				"thread_id", threadID,
				"web_search_enabled", true,
				"web_search_provider", "tavily",
			)
		} else {
			f.logger.Warn("tavily_web_search requested but SEARCH_API_KEY not configured")
		}
	} else if sliceutil.Contains(requestedTools, "brave_web_search") {
		f.logger.Warn("brave_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "serper_web_search") {
		f.logger.Warn("serper_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "exa_web_search") {
		f.logger.Warn("exa_web_search requested but not yet implemented")
	} else {
		f.logger.Debug("per-request tool registry created",
			"project_id", inputs.ProjectID,
			"thread_id", threadID,
			"web_search_enabled", false,
			"web_search_provider", "",
		)
	}

	if inputs.Persona != nil {
		builder.WithPersonaToolFilter(inputs.Persona.Tools, inputs.Persona.DisallowedTools)
	}

	return builder.Build()
}

// commonBuilder creates a ToolRegistryBuilder with tools shared by temp and production variants.
func (f *ToolRegistryFactory) commonBuilder(inputs ToolRegistryInputs, skills []domainagents.RuntimeSkill) *tools.ToolRegistryBuilder {
	return tools.NewToolRegistryBuilder().
		WithNamespaceService(f.namespaceSvc).
		WithMutationStrategy(f.mutationStrategy).
		WithWorkItemSlug(inputs.WorkItemSlug).
		WithEnabledDocumentTools(inputs.EnabledTools, inputs.ProjectID, inputs.UserID, f.documentSvc, f.folderSvc).
		WithEnabledSkillTools(inputs.EnabledTools, inputs.ProjectID, f.skillResolver, false, skills)
}
