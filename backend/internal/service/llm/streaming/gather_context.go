package streaming

// gather_context.go — Pipeline stage 1: resolve thread, project, model, provider, and request params.
// On cold start, creates the thread in a transaction so threadID exists before prompt resolution.

import (
	"context"
	"fmt"
	"time"

	"meridian/internal/domain"
	domainllm "meridian/internal/domain/llm"
)

// gatherContext resolves all context needed before prompt assembly.
//
// On cold start (new thread): creates the thread in a transaction so that threadID
// is valid before assemblePrompt runs. This fixes the bug where
// resolveSystemPromptForParams was called with threadID="" on cold start.
//
// Outputs populated on p: threadCtx, project, requestParams, params, model, provider,
// createdThread (cold start only), streamAcquired.
func (p *turnPipeline) gatherContext(ctx context.Context) error {
	svc := p.svc
	req := p.req

	// Resolve thread context: determine threadID, projectID, and whether cold start
	threadCtx, err := svc.resolveThreadContext(ctx, req)
	if err != nil {
		return err
	}
	p.threadCtx = threadCtx

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
		)
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
