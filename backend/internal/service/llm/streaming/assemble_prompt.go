package streaming

// assemble_prompt.go — Pipeline stage 2: build tool registry, generate tool section,
// and resolve the final system prompt for the LLM request.

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/tools"
)

// assemblePrompt builds the tool registry and resolves the system prompt.
//
// Depends on gatherContext outputs: threadCtx, params, requestParams.
// Outputs populated on p: availableSkills, enabledTools (params.System updated in-place).
func (p *turnPipeline) assemblePrompt(ctx context.Context) error {
	svc := p.svc
	req := p.req

	// Extract enabled tools from requestParams for tool registration
	p.enabledTools = extractToolNames(p.requestParams)

	// Load skills once for tool metadata enrichment (shared across both registries).
	// Skills metadata is now owned by the tool system (not the system prompt resolver)
	// so it's naturally excluded when the model doesn't support tools.
	projectUUID, err := uuid.Parse(p.threadCtx.projectID)
	if err != nil {
		svc.logger.Warn("failed to parse project UUID for skill loading; skills unavailable",
			"project_id", p.threadCtx.projectID,
			"error", err,
		)
	} else {
		skills, _, listErr := svc.skillResolver.List(ctx, projectUUID)
		if listErr != nil {
			svc.logger.Warn("failed to load skills for tool metadata", "error", listErr)
		} else {
			p.availableSkills = skills
		}
	}

	// Build tool registry to generate tool section for system prompt (OCP compliance).
	// Tools self-describe via metadata; registry generates the section dynamically.
	// WithPersonaToolFilter is applied last so it prunes after all tools are registered.
	//
	// WorkItemSlug must match the production registry so the tool section accurately
	// reflects which .meridian/work/ paths are accessible.
	workItemSlug := ""
	if p.resolvedWorkItem != nil {
		workItemSlug = p.resolvedWorkItem.Slug
	}
	tempRegistryBuilder := tools.NewToolRegistryBuilder().
		WithNamespaceService(svc.namespaceSvc).
		WithMutationStrategy(svc.mutationStrategy).
		WithWorkItemSlug(workItemSlug).
		WithEnabledDocumentTools(p.enabledTools, p.threadCtx.projectID, req.UserID, svc.documentSvc, svc.folderSvc).
		WithEnabledSkillTools(p.enabledTools, p.threadCtx.projectID, svc.skillResolver, false, p.availableSkills)

	// Persona tool filter: applied AFTER all tools are registered (OCP compliance).
	if p.resolvedPersona != nil {
		tempRegistryBuilder.WithPersonaToolFilter(p.resolvedPersona.Tools, p.resolvedPersona.DisallowedTools)
	}

	tempToolRegistry := tempRegistryBuilder.Build()

	// toolSection is local — it feeds resolveSystemPromptForParams but is not needed
	// by later pipeline stages (launchStream uses the production registry, not this temp one).
	toolSection := tempToolRegistry.BuildSystemPromptSection()

	// Extract persona body for system prompt injection (position 7).
	// nil when no persona is resolved — existing non-persona turns unaffected.
	var personaBody *string
	if p.resolvedPersona != nil && p.resolvedPersona.SystemPrompt != "" {
		personaBody = &p.resolvedPersona.SystemPrompt
	}

	// Skill override: when the persona declares an explicit Skills list, use it instead
	// of the client-provided selected_skills. Personas do not inherit skills from the
	// caller context; the list in the frontmatter is the complete set.
	selectedSkills := req.SelectedSkills
	if p.resolvedPersona != nil && len(p.resolvedPersona.Skills) > 0 {
		selectedSkills = p.resolvedPersona.Skills
		svc.logger.Debug("persona skill override applied",
			"slug", p.resolvedPersona.Slug,
			"skills", p.resolvedPersona.Skills,
		)
	}

	// Resolve system prompt from user, project, thread, selected skills, persona, and work context.
	// threadCtx.threadID is now guaranteed valid (even on cold start) thanks to gatherContext.
	if err := svc.resolveSystemPromptForParams(ctx, p.threadCtx.threadID, p.threadCtx.projectID, req.UserID, p.params, selectedSkills, toolSection, personaBody, p.workContext); err != nil {
		svc.logger.Error("failed to resolve system prompt", "error", err)
		return err
	}

	return nil
}

// resolveSystemPromptForParams resolves system prompt from multiple sources and updates params.
// This consolidates logic shared between CreateTurn and BuildDebugProviderRequest.
//
// Builds a PromptContext from the provided fields and delegates to SystemPromptResolver.Resolve,
// which applies 7-position composition (see domain/llm.SystemPromptResolver for ordering).
//
// PersonaBody and WorkContext are wired from the turnPipeline when a persona is resolved.
// For non-persona turns these remain nil, preserving existing behavior.
// Pass toolSection from ToolRegistry.BuildSystemPromptSection()
// for OCP compliance — tools self-describe their section dynamically.
func (s *Service) resolveSystemPromptForParams(
	ctx context.Context,
	threadID string,
	projectID string,
	userID string,
	params *domainllm.RequestParams,
	selectedSkills []string,
	toolSection string,
	personaBody *string,
	workContext *domainllm.WorkContext,
) error {
	pc := domainllm.PromptContext{
		ThreadID:       threadID,
		ProjectID:      projectID,
		UserID:         userID,
		UserSystem:     params.System,
		SelectedSkills: selectedSkills,
		ToolSection:    toolSection,
		PersonaBody:    personaBody,
		WorkContext:    workContext,
	}

	systemPrompt, err := s.systemPromptResolver.Resolve(ctx, pc)
	if err != nil {
		return fmt.Errorf("failed to resolve system prompt: %w", err)
	}

	// Resolve always returns at least the base identity prompt.
	s.logger.Debug("final system prompt for LLM",
		"length", len(systemPrompt),
		"tool_section_length", len(toolSection),
		"has_persona", personaBody != nil,
		"has_work_context", workContext != nil,
	)
	params.System = &systemPrompt
	return nil
}
