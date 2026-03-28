package streaming

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	billing "meridian/internal/domain/billing"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
)

// TurnContextResolver resolves all request context before prompt assembly.
// Owns: thread resolution, persona resolution, model/provider selection,
// request param preparation, capability filtering, and stream-slot acquisition.
type TurnContextResolver struct {
	turnReader             domainllm.TurnReader
	threadRepo             domainllm.ThreadStore
	projectRepo            domaindocsys.ProjectStore
	validator              ThreadValidator
	personaCatalog         domainagents.PersonaCatalog
	workItemSvc            domainwi.Service
	contextResolver        *contextResolver
	creditAdmissionChecker billing.CreditAdmissionChecker
	userStreamTracker      *UserStreamTracker
	capabilityRegistry     *capabilities.Registry
	config                 *config.Config
	txManager              domain.TransactionManager
	logger                 *slog.Logger
}

// TurnContextResolverDeps groups dependencies for TurnContextResolver.
type TurnContextResolverDeps struct {
	TurnReader             domainllm.TurnReader
	ThreadRepo             domainllm.ThreadStore
	ProjectRepo            domaindocsys.ProjectStore
	Validator              ThreadValidator
	PersonaCatalog         domainagents.PersonaCatalog
	WorkItemSvc            domainwi.Service
	WorkItemStore          domainwi.Store
	CreditAdmissionChecker billing.CreditAdmissionChecker
	UserStreamTracker      *UserStreamTracker
	CapabilityRegistry     *capabilities.Registry
	Config                 *config.Config
	TxManager              domain.TransactionManager
	Logger                 *slog.Logger
}

// TurnContext holds outputs from context resolution (pipeline stage 1).
// Replaces the scattered turnPipeline fields previously set by gatherContext.
type TurnContext struct {
	ThreadCtx        *threadContext
	Project          *domaindocsys.Project
	RequestParams    map[string]interface{}
	Params           *domainllm.RequestParams
	Model            string
	Provider         string
	CreatedThread    *domainllm.Thread
	StreamAcquired   bool
	ResolvedPersona  *domainagents.Persona
	ResolvedWorkItem *domainwi.WorkItem
	WorkContext      *domainllm.WorkContext
	EnabledTools     []string
}

func NewTurnContextResolver(deps TurnContextResolverDeps) *TurnContextResolver {
	var ctxResolver *contextResolver
	if deps.WorkItemStore != nil {
		ctxResolver = NewContextResolver(deps.WorkItemStore)
	}

	return &TurnContextResolver{
		turnReader:             deps.TurnReader,
		threadRepo:             deps.ThreadRepo,
		projectRepo:            deps.ProjectRepo,
		validator:              deps.Validator,
		personaCatalog:         deps.PersonaCatalog,
		workItemSvc:            deps.WorkItemSvc,
		contextResolver:        ctxResolver,
		creditAdmissionChecker: deps.CreditAdmissionChecker,
		userStreamTracker:      deps.UserStreamTracker,
		capabilityRegistry:     deps.CapabilityRegistry,
		config:                 deps.Config,
		txManager:              deps.TxManager,
		logger:                 deps.Logger,
	}
}

// Resolve executes full stage-1 context resolution.
func (r *TurnContextResolver) Resolve(ctx context.Context, req *domainllm.CreateTurnRequest) (*TurnContext, error) {
	turnCtx := &TurnContext{}

	threadCtx, err := r.ResolveThreadContext(ctx, req)
	if err != nil {
		return nil, err
	}
	turnCtx.ThreadCtx = threadCtx

	if err := r.resolvePersona(ctx, req, turnCtx); err != nil {
		return nil, err
	}

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

		if turnCtx.ResolvedPersona != nil {
			thread.Persona = &turnCtx.ResolvedPersona.Slug
		}

		if err := r.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			return r.threadRepo.CreateThread(txCtx, thread)
		}); err != nil {
			return nil, fmt.Errorf("failed to create thread (cold start): %w", err)
		}

		threadCtx.threadID = thread.ID
		turnCtx.CreatedThread = thread

		r.logger.Debug("thread created (cold start)",
			"id", thread.ID,
			"title", thread.Title,
			"project_id", threadCtx.projectID,
			"user_id", req.UserID,
			"persona", thread.Persona,
		)
	}

	if turnCtx.ResolvedPersona != nil {
		if err := r.ensureWorkItemAndResolveContext(ctx, req, turnCtx); err != nil {
			return nil, err
		}
	}

	project, err := r.projectRepo.GetByID(ctx, threadCtx.projectID, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to load project for tool policy: %w", err)
	}
	turnCtx.Project = project

	if err := r.resolveRequestParams(req, turnCtx); err != nil {
		return nil, err
	}

	r.resolveModelAndProvider(turnCtx)
	r.applyPersonaOverrides(turnCtx)
	r.applyModelCapabilities(turnCtx)

	turnCtx.EnabledTools = extractToolNames(turnCtx.RequestParams)

	hasPurchased := r.creditAdmissionChecker.HasPurchasedCredits(ctx, req.UserID)
	if err := r.userStreamTracker.Acquire(req.UserID, hasPurchased); err != nil {
		return nil, err
	}
	turnCtx.StreamAcquired = true

	return turnCtx, nil
}

func (r *TurnContextResolver) ReleaseStreamSlot(userID string) {
	r.userStreamTracker.Release(userID)
}

// ResolveThreadContext determines which thread to use for turn creation.
// Priority: PrevTurnID > ThreadID > ProjectID > error.
func (r *TurnContextResolver) ResolveThreadContext(ctx context.Context, req *domainllm.CreateTurnRequest) (*threadContext, error) {
	if req.PrevTurnID != nil {
		prevTurn, err := r.turnReader.GetTurn(ctx, *req.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("prev_turn_id references non-existent turn: %w", err)
		}

		if err := r.validator.ValidateThread(ctx, prevTurn.ThreadID, req.UserID); err != nil {
			return nil, err
		}

		thread, err := r.threadRepo.GetThread(ctx, prevTurn.ThreadID, req.UserID)
		if err != nil {
			return nil, err
		}

		return &threadContext{
			threadID:    prevTurn.ThreadID,
			projectID:   thread.ProjectID,
			isNewThread: false,
			thread:      thread,
		}, nil
	}

	if req.ThreadID != nil {
		if err := r.validator.ValidateThread(ctx, *req.ThreadID, req.UserID); err != nil {
			return nil, err
		}

		thread, err := r.threadRepo.GetThread(ctx, *req.ThreadID, req.UserID)
		if err != nil {
			return nil, err
		}

		return &threadContext{
			threadID:    *req.ThreadID,
			projectID:   thread.ProjectID,
			isNewThread: false,
			thread:      thread,
		}, nil
	}

	if req.ProjectID != nil {
		_, err := r.projectRepo.GetByID(ctx, *req.ProjectID, req.UserID)
		if err != nil {
			return nil, fmt.Errorf("project_id references inaccessible project: %w", err)
		}

		return &threadContext{
			threadID:    "",
			projectID:   *req.ProjectID,
			isNewThread: true,
		}, nil
	}

	return nil, domain.NewValidationError("must provide thread_id, project_id, or prev_turn_id")
}

func (r *TurnContextResolver) resolvePersona(ctx context.Context, req *domainllm.CreateTurnRequest, turnCtx *TurnContext) error {
	var personaSlug string
	switch {
	case req.PersonaSlug != nil && *req.PersonaSlug != "":
		personaSlug = *req.PersonaSlug

	case turnCtx.ThreadCtx.thread != nil &&
		turnCtx.ThreadCtx.thread.Persona != nil &&
		*turnCtx.ThreadCtx.thread.Persona != "":
		personaSlug = *turnCtx.ThreadCtx.thread.Persona
		r.logger.Debug("persona slug inherited from thread",
			"thread_id", turnCtx.ThreadCtx.threadID,
			"persona_slug", personaSlug,
		)

	default:
		return nil
	}

	if r.personaCatalog == nil {
		return domain.NewValidationError("persona_slug provided but persona catalog is not configured")
	}

	projectUUID, err := uuid.Parse(turnCtx.ThreadCtx.projectID)
	if err != nil {
		return fmt.Errorf("invalid project UUID for persona resolution: %w", err)
	}

	persona, err := r.personaCatalog.ResolvePersona(ctx, projectUUID, personaSlug)
	if err != nil {
		var domErr *domainerrors.DomainError
		if errors.As(err, &domErr) {
			return err
		}
		return fmt.Errorf("failed to resolve persona %q: %w", personaSlug, err)
	}

	turnCtx.ResolvedPersona = persona
	r.logger.Debug("persona resolved",
		"slug", persona.Slug,
		"name", persona.Name,
		"model", persona.Model,
		"project_id", turnCtx.ThreadCtx.projectID,
	)
	return nil
}

func (r *TurnContextResolver) ensureWorkItemAndResolveContext(ctx context.Context, req *domainllm.CreateTurnRequest, turnCtx *TurnContext) error {
	if r.workItemSvc == nil {
		r.logger.Warn("persona turn requested but WorkItemSvc not configured; skipping work item gate")
		return nil
	}

	var workItemID *string
	if turnCtx.CreatedThread != nil {
		workItemID = turnCtx.CreatedThread.WorkItemID
	} else {
		thread, err := r.threadRepo.GetThread(ctx, turnCtx.ThreadCtx.threadID, req.UserID)
		if err != nil {
			return fmt.Errorf("failed to load thread for work item gate: %w", err)
		}
		workItemID = thread.WorkItemID
	}

	workItem, err := r.workItemSvc.EnsureThreadWorkItem(
		ctx, turnCtx.ThreadCtx.projectID, turnCtx.ThreadCtx.threadID, req.UserID, workItemID,
	)
	if err != nil {
		return fmt.Errorf("failed to ensure thread work item: %w", err)
	}
	turnCtx.ResolvedWorkItem = workItem

	if workItem.Status == domainwi.StatusDone {
		return domainerrors.WorkItemDone(workItem.Slug)
	}
	if workItem.DeletedAt != nil {
		return domainerrors.WorkItemDeleted(workItem.Slug)
	}

	if r.contextResolver != nil {
		resolved, err := r.contextResolver.ResolveWorkContext(ctx, turnCtx.ThreadCtx.threadID, &workItem.ID)
		if err != nil {
			r.logger.Warn("failed to resolve work context; continuing without work context",
				"thread_id", turnCtx.ThreadCtx.threadID,
				"work_item_id", workItem.ID,
				"error", err,
			)
		} else {
			turnCtx.WorkContext = &domainllm.WorkContext{
				WorkDir:  resolved.WorkDir,
				FSDir:    resolved.FSDir,
				ThreadID: resolved.ThreadID,
				WorkItem: resolved.WorkItem,
			}
		}
	}

	r.logger.Debug("work item gate passed",
		"thread_id", turnCtx.ThreadCtx.threadID,
		"work_item_id", workItem.ID,
		"work_item_slug", workItem.Slug,
		"work_item_status", workItem.Status,
		"has_work_context", turnCtx.WorkContext != nil,
	)
	return nil
}

func (r *TurnContextResolver) resolveRequestParams(req *domainllm.CreateTurnRequest, turnCtx *TurnContext) error {
	requestParams := req.RequestParams
	if requestParams == nil {
		requestParams = make(map[string]interface{})
	}

	disabled := parseDisabledTools(turnCtx.Project.Preferences)
	toolNames := resolveServerToolNames(r.config.LLM.SearchAPIKey != "", disabled)
	toolsParam, err := toolNamesToRequestParamsTools(toolNames)
	if err != nil {
		return fmt.Errorf("failed to build tools for request params: %w", err)
	}
	requestParams["tools"] = toolsParam

	if err := domainllm.ValidateRequestParams(requestParams); err != nil {
		r.logger.Error("invalid request params", "error", err)
		return fmt.Errorf("invalid request params: %w", err)
	}

	params, err := domainllm.GetRequestParamStruct(requestParams)
	if err != nil {
		r.logger.Error("failed to parse request params", "error", err)
		return fmt.Errorf("failed to parse request params: %w", err)
	}

	turnCtx.RequestParams = requestParams
	turnCtx.Params = params
	return nil
}

func (r *TurnContextResolver) resolveModelAndProvider(turnCtx *TurnContext) {
	model := r.config.LLM.DefaultModel
	if model == "" {
		model = defaultFallbackModel
	}
	if turnCtx.Params.Model != nil && *turnCtx.Params.Model != "" {
		model = *turnCtx.Params.Model
	}

	var provider string
	if turnCtx.Params.Provider != nil && *turnCtx.Params.Provider != "" {
		provider = *turnCtx.Params.Provider
	} else {
		if mappedProvider, found := domainllm.GetProviderForModel(model); found {
			provider = mappedProvider
		} else {
			provider = "openrouter"
		}
		turnCtx.RequestParams["provider"] = provider
	}

	turnCtx.Model = model
	turnCtx.Provider = provider
}

func (r *TurnContextResolver) applyModelCapabilities(turnCtx *TurnContext) {
	modelCap, err := r.capabilityRegistry.GetModelCapabilities(turnCtx.Provider, turnCtx.Model)
	if err != nil {
		r.logger.Warn("model not found in capability registry, skipping tool filter",
			"provider", turnCtx.Provider,
			"model", turnCtx.Model,
			"error", err,
		)
		return
	}

	if !modelCap.SupportsTools && turnCtx.Params.Tools != nil && len(turnCtx.Params.Tools) > 0 {
		r.logger.Debug("filtering out tools - model doesn't support tools",
			"provider", turnCtx.Provider,
			"model", turnCtx.Model,
			"tools_count", len(turnCtx.Params.Tools),
		)
		turnCtx.Params.Tools = nil
		delete(turnCtx.RequestParams, "tools")
	}

	if modelCap.ProviderRouting != nil {
		if turnCtx.Params.ProviderOrder == nil && len(modelCap.ProviderRouting.Order) > 0 {
			turnCtx.Params.ProviderOrder = modelCap.ProviderRouting.Order
			turnCtx.RequestParams["provider_order"] = modelCap.ProviderRouting.Order
		}
		if turnCtx.Params.ProviderIgnore == nil && len(modelCap.ProviderRouting.Ignore) > 0 {
			turnCtx.Params.ProviderIgnore = modelCap.ProviderRouting.Ignore
			turnCtx.RequestParams["provider_ignore"] = modelCap.ProviderRouting.Ignore
		}
		if turnCtx.Params.ProviderOnly == nil && len(modelCap.ProviderRouting.Only) > 0 {
			turnCtx.Params.ProviderOnly = modelCap.ProviderRouting.Only
			turnCtx.RequestParams["provider_only"] = modelCap.ProviderRouting.Only
		}
		if turnCtx.Params.AllowFallbacks == nil && modelCap.ProviderRouting.AllowFallbacks != nil {
			turnCtx.Params.AllowFallbacks = modelCap.ProviderRouting.AllowFallbacks
			turnCtx.RequestParams["allow_fallbacks"] = *modelCap.ProviderRouting.AllowFallbacks
		}
		if turnCtx.Params.ProviderSort == nil && modelCap.ProviderRouting.Sort != nil {
			turnCtx.Params.ProviderSort = modelCap.ProviderRouting.Sort
			turnCtx.RequestParams["provider_sort"] = *modelCap.ProviderRouting.Sort
		}
	}
}

func (r *TurnContextResolver) applyPersonaOverrides(turnCtx *TurnContext) {
	if turnCtx.ResolvedPersona == nil {
		return
	}
	persona := turnCtx.ResolvedPersona

	if persona.Model != "" && persona.Model != "inherit" {
		turnCtx.Model = persona.Model
		turnCtx.Params.Model = &persona.Model
		turnCtx.RequestParams["model"] = persona.Model

		if persona.Provider != "" {
			turnCtx.Provider = persona.Provider
		} else if mappedProvider, found := domainllm.GetProviderForModel(persona.Model); found {
			turnCtx.Provider = mappedProvider
		} else {
			turnCtx.Provider = "openrouter"
		}
		turnCtx.RequestParams["provider"] = turnCtx.Provider

		r.logger.Debug("persona model override applied",
			"slug", persona.Slug,
			"model", turnCtx.Model,
			"provider", turnCtx.Provider,
		)
	}

	if persona.Temperature != nil {
		turnCtx.Params.Temperature = persona.Temperature
		turnCtx.RequestParams["temperature"] = *persona.Temperature
		r.logger.Debug("persona temperature override applied",
			"slug", persona.Slug,
			"temperature", *persona.Temperature,
		)
	}

	if persona.MaxTokens != nil {
		turnCtx.Params.MaxTokens = persona.MaxTokens
		turnCtx.RequestParams["max_tokens"] = *persona.MaxTokens
		r.logger.Debug("persona max_tokens override applied",
			"slug", persona.Slug,
			"max_tokens", *persona.MaxTokens,
		)
	}
}
