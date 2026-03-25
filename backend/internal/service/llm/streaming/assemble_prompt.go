package streaming

// assemble_prompt.go — Pipeline stage 2: build tool registry, generate tool section,
// and resolve the final system prompt for the LLM request.

import (
	"context"
	"fmt"

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
	availableSkills, err := svc.skillService.ListSkills(ctx, req.UserID, p.threadCtx.projectID)
	if err != nil {
		svc.logger.Warn("failed to load skills for tool metadata", "error", err)
		availableSkills = nil // Continue without skills — non-fatal
	}
	p.availableSkills = availableSkills

	// Build tool registry to generate tool section for system prompt (OCP compliance)
	// Tools self-describe via metadata, registry generates the section dynamically
	tempToolRegistry := tools.NewToolRegistryBuilder().
		WithNamespaceService(svc.namespaceSvc).
		WithMutationStrategy(svc.mutationStrategy).
		WithEnabledDocumentTools(p.enabledTools, p.threadCtx.projectID, req.UserID, svc.documentSvc, svc.folderSvc).
		WithEnabledSkillTools(p.enabledTools, p.threadCtx.projectID, req.UserID, svc.skillService, false, p.availableSkills).
		Build()

	// toolSection is local — it feeds resolveSystemPromptForParams but is not needed
	// by later pipeline stages (launchStream uses the production registry, not this temp one).
	toolSection := tempToolRegistry.BuildSystemPromptSection()

	// Resolve system prompt from user, project, thread, and selected skills.
	// threadCtx.threadID is now guaranteed valid (even on cold start) thanks to gatherContext.
	if err := svc.resolveSystemPromptForParams(ctx, p.threadCtx.threadID, p.threadCtx.projectID, req.UserID, p.params, req.SelectedSkills, toolSection); err != nil {
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
// Extension points PersonaBody and WorkContext are nil here (set to non-nil by future
// persona/work-item features). Pass toolSection from ToolRegistry.BuildSystemPromptSection()
// for OCP compliance — tools self-describe their section dynamically.
func (s *Service) resolveSystemPromptForParams(
	ctx context.Context,
	threadID string,
	projectID string,
	userID string,
	params *domainllm.RequestParams,
	selectedSkills []string,
	toolSection string,
) error {
	pc := domainllm.PromptContext{
		ThreadID:       threadID,
		ProjectID:      projectID,
		UserID:         userID,
		UserSystem:     params.System,
		SelectedSkills: selectedSkills,
		ToolSection:    toolSection,
		// PersonaBody and WorkContext are nil — extension points for future features.
	}

	systemPrompt, err := s.systemPromptResolver.Resolve(ctx, pc)
	if err != nil {
		return fmt.Errorf("failed to resolve system prompt: %w", err)
	}

	// Resolve always returns at least the base identity prompt.
	s.logger.Debug("final system prompt for LLM",
		"length", len(systemPrompt),
		"tool_section_length", len(toolSection),
	)
	params.System = &systemPrompt
	return nil
}
