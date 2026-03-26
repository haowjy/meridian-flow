package streaming

// gather_context.go — Pipeline stage 1: resolve thread, project, model, provider, and request params.
// On cold start, creates the thread in a transaction so threadID exists before prompt resolution.
//
// Persona integration (P2): when req.PersonaSlug is non-nil, this stage also:
//   - Resolves the persona via PersonaCatalog (422 if not found)
//   - Ensures the thread has a work item via EnsureThreadWorkItem
//   - Gates on work item lifecycle (409 if done/deleted)
//   - Resolves work context variables for system prompt injection
//
// All persona logic is gated on req.PersonaSlug being non-nil, so existing
// non-persona turns are completely unaffected.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domainerrors "meridian/internal/domain/errors"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
)

// gatherContext resolves all context needed before prompt assembly.
//
// On cold start (new thread): creates the thread in a transaction so that threadID
// is valid before assemblePrompt runs. This fixes the bug where
// resolveSystemPromptForParams was called with threadID="" on cold start.
//
// When a persona slug is provided, this stage additionally:
//   - Resolves the persona via PersonaCatalog (422 if not found/invalid)
//   - Ensures the thread has a work item (EnsureThreadWorkItem)
//   - Gates on work item lifecycle (409 if done/deleted)
//   - Resolves work context variables for system prompt position 3
//
// Outputs populated on p: threadCtx, project, requestParams, params, model, provider,
// createdThread (cold start only), streamAcquired, resolvedPersona, resolvedWorkItem,
// workContext (persona turns only).
func (p *turnPipeline) gatherContext(ctx context.Context) error {
	svc := p.svc
	req := p.req

	// Resolve thread context: determine threadID, projectID, and whether cold start
	threadCtx, err := svc.resolveThreadContext(ctx, req)
	if err != nil {
		return err
	}
	p.threadCtx = threadCtx

	// Resolve persona early (before thread creation) so we can set the persona
	// slug on the cold-start thread and fail fast on invalid slugs.
	if err := p.resolvePersona(ctx); err != nil {
		return err
	}

	// Cold-start fix: create thread BEFORE prompt resolution so threadID is valid.
	// Previously this happened inside the turn-creation ExecTx, which meant
	// resolveSystemPromptForParams received threadID="".
	if threadCtx.isNewThread {
		now := time.Now().UTC()
		title := deriveTitleFromTurnBlocks(req.TurnBlocks)
		thread := &domainllm.Thread{
			ProjectID: threadCtx.projectID,
			UserID:    req.UserID,
			Title:     title,
			CreatedAt: now,
			UpdatedAt: now,
		}

		// Set persona slug on thread if a persona was resolved.
		if p.resolvedPersona != nil {
			thread.Persona = &p.resolvedPersona.Slug
		}

		if err := svc.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			return svc.threadRepo.CreateThread(txCtx, thread)
		}); err != nil {
			return fmt.Errorf("failed to create thread (cold start): %w", err)
		}

		threadCtx.threadID = thread.ID
		p.createdThread = thread

		svc.logger.Debug("thread created (cold start)",
			"id", thread.ID,
			"title", thread.Title,
			"project_id", threadCtx.projectID,
			"user_id", req.UserID,
			"persona", thread.Persona,
		)
	}

	// Persona-only: work item gate + context resolution.
	// Skipped entirely for non-persona turns to preserve backwards compatibility.
	if p.resolvedPersona != nil {
		if err := p.ensureWorkItemAndResolveContext(ctx); err != nil {
			return err
		}
	}

	// Load project for tool policy enforcement
	project, err := svc.projectRepo.GetByID(ctx, threadCtx.projectID, req.UserID)
	if err != nil {
		return fmt.Errorf("failed to load project for tool policy: %w", err)
	}
	p.project = project

	// Prepare request params
	if err := p.resolveRequestParams(); err != nil {
		return err
	}

	// Resolve model and provider from params
	p.resolveModelAndProvider()

	// Apply persona overrides (model, temperature, max_tokens) AFTER request-param
	// resolution and BEFORE capability filtering so capability lookups use the
	// overridden model name.
	p.applyPersonaOverrides()

	// Filter tools/capabilities based on model
	p.applyModelCapabilities()

	// Enforce per-user concurrent stream limit before committing resources.
	hasPurchased := svc.creditAdmissionChecker.HasPurchasedCredits(ctx, req.UserID)
	if err := svc.userStreamTracker.Acquire(req.UserID, hasPurchased); err != nil {
		return err
	}
	p.streamAcquired = true

	return nil
}

// resolvePersona resolves the persona from req.PersonaSlug via PersonaCatalog.
// No-op when PersonaSlug is nil/empty AND the thread has no stored persona.
//
// Slug priority:
//  1. Explicit req.PersonaSlug (client-provided).
//  2. Thread's stored persona slug (warm-start fallback): restores persona context
//     on follow-up turns when the client does not resend the slug.
//
// Sets p.resolvedPersona on success. Returns a DomainError on failure:
//   - PERSONA_NOT_FOUND (422) if the slug references a non-existent persona
//   - PERSONA_INVALID (422) if the persona file has malformed frontmatter
//   - ValidationError if PersonaCatalog is not configured but a slug was provided
func (p *turnPipeline) resolvePersona(ctx context.Context) error {
	svc := p.svc
	req := p.req

	// Determine the effective persona slug.
	var personaSlug string
	switch {
	case req.PersonaSlug != nil && *req.PersonaSlug != "":
		// Explicit slug from the current request — highest priority.
		personaSlug = *req.PersonaSlug

	case p.threadCtx.thread != nil &&
		p.threadCtx.thread.Persona != nil &&
		*p.threadCtx.thread.Persona != "":
		// Warm-start fallback: client omitted persona slug but the thread was
		// created with one. Restore persona context so the model override,
		// persona system-prompt body, and tool filter all apply on follow-up turns.
		personaSlug = *p.threadCtx.thread.Persona
		svc.logger.Debug("persona slug inherited from thread",
			"thread_id", p.threadCtx.threadID,
			"persona_slug", personaSlug,
		)

	default:
		// No persona slug → no-op (existing non-persona turns unaffected).
		return nil
	}

	// PersonaCatalog must be configured if a slug is provided.
	if svc.personaCatalog == nil {
		return domain.NewValidationError("persona_slug provided but persona catalog is not configured")
	}

	projectUUID, err := uuid.Parse(p.threadCtx.projectID)
	if err != nil {
		return fmt.Errorf("invalid project UUID for persona resolution: %w", err)
	}

	persona, err := svc.personaCatalog.ResolvePersona(ctx, projectUUID, personaSlug)
	if err != nil {
		// DomainErrors (PersonaNotFound, PersonaInvalid) propagate directly
		// to the handler for proper HTTP status mapping.
		var domErr *domainerrors.DomainError
		if errors.As(err, &domErr) {
			return err
		}
		return fmt.Errorf("failed to resolve persona %q: %w", personaSlug, err)
	}

	p.resolvedPersona = persona
	svc.logger.Debug("persona resolved",
		"slug", persona.Slug,
		"name", persona.Name,
		"model", persona.Model,
		"project_id", p.threadCtx.projectID,
	)
	return nil
}

// ensureWorkItemAndResolveContext guarantees the thread has a work item,
// checks the work item lifecycle, and resolves work context variables.
//
// Only called for persona turns. This ensures:
//   - Thread has a work item (creates ephemeral if needed via EnsureThreadWorkItem)
//   - Work item is active (409 if done, 409 if deleted)
//   - Work context variables are resolved for system prompt injection
func (p *turnPipeline) ensureWorkItemAndResolveContext(ctx context.Context) error {
	svc := p.svc
	req := p.req
	threadCtx := p.threadCtx

	// WorkItemSvc must be configured for persona turns.
	if svc.workItemSvc == nil {
		svc.logger.Warn("persona turn requested but WorkItemSvc not configured; skipping work item gate")
		return nil
	}

	// Get thread's current work_item_id. On cold start, the thread was just
	// created so we have it in p.createdThread. On warm start, we need to load it.
	var workItemID *string
	if p.createdThread != nil {
		workItemID = p.createdThread.WorkItemID
	} else {
		thread, err := svc.threadRepo.GetThread(ctx, threadCtx.threadID, req.UserID)
		if err != nil {
			return fmt.Errorf("failed to load thread for work item gate: %w", err)
		}
		workItemID = thread.WorkItemID
	}

	// EnsureThreadWorkItem: creates ephemeral work item if thread has none.
	workItem, err := svc.workItemSvc.EnsureThreadWorkItem(
		ctx, threadCtx.projectID, threadCtx.threadID, req.UserID, workItemID,
	)
	if err != nil {
		return fmt.Errorf("failed to ensure thread work item: %w", err)
	}
	p.resolvedWorkItem = workItem

	// Work item lifecycle gate: reject turns on done or deleted work items.
	// EnsureThreadWorkItem returns the work item with current status. If it
	// was soft-deleted, GetByID inside EnsureThreadWorkItem returns NotFound
	// and a new ephemeral is created, so we only gate on "done" here.
	if workItem.Status == domainwi.StatusDone {
		return domainerrors.WorkItemDone(workItem.Slug)
	}
	// Defensive: if somehow a deleted work item is returned (shouldn't happen
	// because Store.GetByID filters deleted), gate on it.
	if workItem.DeletedAt != nil {
		return domainerrors.WorkItemDeleted(workItem.Slug)
	}

	// Resolve work context variables for system prompt injection (position 3).
	if svc.contextResolver != nil {
		resolved, err := svc.contextResolver.ResolveWorkContext(ctx, threadCtx.threadID, &workItem.ID)
		if err != nil {
			svc.logger.Warn("failed to resolve work context; continuing without work context",
				"thread_id", threadCtx.threadID,
				"work_item_id", workItem.ID,
				"error", err,
			)
			// Non-fatal: continue without work context rather than failing the turn.
		} else {
			p.workContext = &domainllm.WorkContext{
				WorkDir:  resolved.WorkDir,
				FSDir:    resolved.FSDir,
				ThreadID: resolved.ThreadID,
				WorkItem: resolved.WorkItem,
			}
		}
	}

	svc.logger.Debug("work item gate passed",
		"thread_id", threadCtx.threadID,
		"work_item_id", workItem.ID,
		"work_item_slug", workItem.Slug,
		"work_item_status", workItem.Status,
		"has_work_context", p.workContext != nil,
	)
	return nil
}

// resolveRequestParams prepares, validates, and parses request params.
// Applies server-side tool policy from project preferences.
func (p *turnPipeline) resolveRequestParams() error {
	svc := p.svc
	req := p.req

	requestParams := req.RequestParams
	if requestParams == nil {
		requestParams = make(map[string]interface{})
	}

	// Server-side tool policy enforcement:
	// - Treat project preferences as the source of truth for tool availability.
	// - Ignore any client-sent request_params.tools (no backwards-compat requirement).
	// - Web search is only included if configured on the server.
	disabled := parseDisabledTools(p.project.Preferences)
	toolNames := resolveServerToolNames(svc.config.LLM.SearchAPIKey != "", disabled)
	toolsParam, err := toolNamesToRequestParamsTools(toolNames)
	if err != nil {
		return fmt.Errorf("failed to build tools for request params: %w", err)
	}
	requestParams["tools"] = toolsParam

	// Validate request params
	if err := domainllm.ValidateRequestParams(requestParams); err != nil {
		svc.logger.Error("invalid request params", "error", err)
		return fmt.Errorf("invalid request params: %w", err)
	}

	params, err := domainllm.GetRequestParamStruct(requestParams)
	if err != nil {
		svc.logger.Error("failed to parse request params", "error", err)
		return fmt.Errorf("failed to parse request params: %w", err)
	}

	p.requestParams = requestParams
	p.params = params
	return nil
}

// resolveModelAndProvider extracts model and provider from params,
// applying defaults and model-to-provider mapping.
func (p *turnPipeline) resolveModelAndProvider() {
	svc := p.svc

	// Extract model from request_params (pure model name, no provider prefix)
	model := svc.config.LLM.DefaultModel
	if model == "" {
		model = defaultFallbackModel // Fallback if config not set
	}
	if p.params.Model != nil && *p.params.Model != "" {
		model = *p.params.Model
	}

	// Extract provider from request_params or infer from model
	var provider string
	if p.params.Provider != nil && *p.params.Provider != "" {
		provider = *p.params.Provider
	} else {
		if mappedProvider, found := domainllm.GetProviderForModel(model); found {
			provider = mappedProvider
		} else {
			provider = "openrouter"
		}
		// Persist resolved provider to request_params for turn history/edit
		p.requestParams["provider"] = provider
	}

	p.model = model
	p.provider = provider
}

// applyModelCapabilities filters tools and applies provider routing
// based on the model's capabilities from the registry.
func (p *turnPipeline) applyModelCapabilities() {
	svc := p.svc

	modelCap, err := svc.capabilityRegistry.GetModelCapabilities(p.provider, p.model)
	if err != nil {
		// Model not found in registry - log warning but continue (fail-open)
		svc.logger.Warn("model not found in capability registry, skipping tool filter",
			"provider", p.provider,
			"model", p.model,
			"error", err,
		)
		return
	}

	if !modelCap.SupportsTools && p.params.Tools != nil && len(p.params.Tools) > 0 {
		svc.logger.Debug("filtering out tools - model doesn't support tools",
			"provider", p.provider,
			"model", p.model,
			"tools_count", len(p.params.Tools),
		)
		p.params.Tools = nil
		delete(p.requestParams, "tools")
	}

	// Apply provider routing from capabilities (OpenRouter)
	if modelCap.ProviderRouting != nil {
		if p.params.ProviderOrder == nil && len(modelCap.ProviderRouting.Order) > 0 {
			p.params.ProviderOrder = modelCap.ProviderRouting.Order
			p.requestParams["provider_order"] = modelCap.ProviderRouting.Order
		}
		if p.params.ProviderIgnore == nil && len(modelCap.ProviderRouting.Ignore) > 0 {
			p.params.ProviderIgnore = modelCap.ProviderRouting.Ignore
			p.requestParams["provider_ignore"] = modelCap.ProviderRouting.Ignore
		}
		if p.params.ProviderOnly == nil && len(modelCap.ProviderRouting.Only) > 0 {
			p.params.ProviderOnly = modelCap.ProviderRouting.Only
			p.requestParams["provider_only"] = modelCap.ProviderRouting.Only
		}
		if p.params.AllowFallbacks == nil && modelCap.ProviderRouting.AllowFallbacks != nil {
			p.params.AllowFallbacks = modelCap.ProviderRouting.AllowFallbacks
			p.requestParams["allow_fallbacks"] = *modelCap.ProviderRouting.AllowFallbacks
		}
		if p.params.ProviderSort == nil && modelCap.ProviderRouting.Sort != nil {
			p.params.ProviderSort = modelCap.ProviderRouting.Sort
			p.requestParams["provider_sort"] = *modelCap.ProviderRouting.Sort
		}
	}
}

// applyPersonaOverrides applies model, temperature, and max_tokens overrides
// from the resolved persona. No-op when no persona is resolved.
//
// Called after resolveModelAndProvider() and before applyModelCapabilities() so that
// capability-based tool filtering uses the persona's model rather than the request model.
//
// Persona.Model values:
//   - "" or "inherit" → use the model already determined by resolveModelAndProvider (no change).
//   - any other value → override p.model, p.params.Model, and re-derive p.provider.
//
// Temperature and MaxTokens are only overridden when the persona frontmatter contains
// an explicit value (non-nil pointer); nil means "inherit from request params".
func (p *turnPipeline) applyPersonaOverrides() {
	if p.resolvedPersona == nil {
		return
	}
	persona := p.resolvedPersona

	// Model override: skip when empty or explicitly set to "inherit".
	if persona.Model != "" && persona.Model != "inherit" {
		p.model = persona.Model
		p.params.Model = &persona.Model
		p.requestParams["model"] = persona.Model

		// Re-derive provider from the overridden model name, respecting explicit persona provider.
		if persona.Provider != "" {
			p.provider = persona.Provider
		} else if mappedProvider, found := domainllm.GetProviderForModel(persona.Model); found {
			p.provider = mappedProvider
		} else {
			p.provider = "openrouter"
		}
		p.requestParams["provider"] = p.provider

		p.svc.logger.Debug("persona model override applied",
			"slug", persona.Slug,
			"model", p.model,
			"provider", p.provider,
		)
	}

	// Temperature override: nil means "inherit from request params".
	if persona.Temperature != nil {
		p.params.Temperature = persona.Temperature
		p.requestParams["temperature"] = *persona.Temperature
		p.svc.logger.Debug("persona temperature override applied",
			"slug", persona.Slug,
			"temperature", *persona.Temperature,
		)
	}

	// MaxTokens override: nil means "inherit from request params".
	if persona.MaxTokens != nil {
		p.params.MaxTokens = persona.MaxTokens
		p.requestParams["max_tokens"] = *persona.MaxTokens
		p.svc.logger.Debug("persona max_tokens override applied",
			"slug", persona.Slug,
			"max_tokens", *persona.MaxTokens,
		)
	}
}

// resolveThreadContext determines which thread to use for turn creation.
//
// Priority:
// 1. If PrevTurnID provided -> lookup its thread from DB (ignores ThreadID/ProjectID params)
// 2. Else if ThreadID provided -> validate and use that thread
// 3. Else if ProjectID provided -> cold start (will create new thread)
// 4. Else -> validation error
func (s *Service) resolveThreadContext(ctx context.Context, req *domainllm.CreateTurnRequest) (*threadContext, error) {
	// Case 1: PrevTurnID provided - infer thread from the turn
	if req.PrevTurnID != nil {
		prevTurn, err := s.turnReader.GetTurn(ctx, *req.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("prev_turn_id references non-existent turn: %w", err)
		}

		// Validate user has access to this thread
		if err := s.validator.ValidateThread(ctx, prevTurn.ThreadID, req.UserID); err != nil {
			return nil, err
		}

		// Get project ID from thread
		thread, err := s.threadRepo.GetThread(ctx, prevTurn.ThreadID, req.UserID)
		if err != nil {
			return nil, err
		}

		return &threadContext{
			threadID:    prevTurn.ThreadID,
			projectID:   thread.ProjectID,
			isNewThread: false,
			thread:      thread, // Retained for persona fallback in resolvePersona
		}, nil
	}

	// Case 2: ThreadID provided - validate and use it
	if req.ThreadID != nil {
		if err := s.validator.ValidateThread(ctx, *req.ThreadID, req.UserID); err != nil {
			return nil, err
		}

		// Get project ID from thread
		thread, err := s.threadRepo.GetThread(ctx, *req.ThreadID, req.UserID)
		if err != nil {
			return nil, err
		}

		return &threadContext{
			threadID:    *req.ThreadID,
			projectID:   thread.ProjectID,
			isNewThread: false,
			thread:      thread, // Retained for persona fallback in resolvePersona
		}, nil
	}

	// Case 3: ProjectID provided - cold start (create new thread)
	if req.ProjectID != nil {
		_, err := s.projectRepo.GetByID(ctx, *req.ProjectID, req.UserID)
		if err != nil {
			return nil, fmt.Errorf("project_id references inaccessible project: %w", err)
		}

		return &threadContext{
			threadID:    "", // Will be set after thread creation in gatherContext
			projectID:   *req.ProjectID,
			isNewThread: true,
		}, nil
	}

	// Case 4: None provided - error
	return nil, domain.NewValidationError("must provide thread_id, project_id, or prev_turn_id")
}
