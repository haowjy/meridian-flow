package streaming

// launch_stream.go — Pipeline stage 4: build production tool registry, create
// StreamExecutor, register stream, and start background streaming execution.

import (
	"context"
	"fmt"

	domainllm "meridian/internal/domain/llm"
	"meridian/internal/pkg/sliceutil"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tools"
	"meridian/internal/service/llm/tools/external"
)

// launchStream creates the executor and starts background streaming.
//
// Depends on all prior stages: threadCtx, createdThread, requestParams, params,
// model, provider, enabledTools, availableSkills, userTurn, assistantTurn.
//
// Returns the CreateTurnResponse to the caller.
func (p *turnPipeline) launchStream(ctx context.Context) (*domainllm.CreateTurnResponse, error) {
	svc := p.svc
	req := p.req

	// Get thread to extract project_id for tools.
	// If we just created the thread (cold start), use createdThread; otherwise fetch it.
	var thread *domainllm.Thread
	if p.createdThread != nil {
		thread = p.createdThread
	} else {
		var threadErr error
		thread, threadErr = svc.threadRepo.GetThread(ctx, p.threadCtx.threadID, req.UserID)
		if threadErr != nil {
			svc.logger.Error("failed to get thread for tools",
				"error", threadErr,
				"thread_id", p.threadCtx.threadID,
				"user_id", req.UserID,
			)
			if updateErr := svc.turnWriter.UpdateTurnError(ctx, p.assistantTurn.ID, fmt.Sprintf("failed to get thread: %v", threadErr)); updateErr != nil {
				svc.logger.Error("failed to update turn error", "error", updateErr)
			}
			return nil, fmt.Errorf("failed to get thread for tools: %w", threadErr)
		}
	}

	// Create per-request tool registry with project-specific tools
	// All tools use service layer (SOLID compliance, Phase 4: zero repo dependencies)
	toolRegistry := p.buildProductionToolRegistry(thread)

	// Get provider adapter (do this synchronously to avoid race)
	llmProvider, err := svc.providerGetter.GetProvider(p.provider)
	if err != nil {
		svc.logger.Error("failed to get provider for streaming",
			"error", err,
			"provider", p.provider,
			"model", p.model,
			"assistant_turn_id", p.assistantTurn.ID,
		)
		if updateErr := svc.turnWriter.UpdateTurnError(ctx, p.assistantTurn.ID, fmt.Sprintf("failed to get provider: %v", err)); updateErr != nil {
			svc.logger.Error("failed to update turn error", "error", updateErr)
		}
		return nil, fmt.Errorf("failed to get provider '%s': %w", p.provider, err)
	}

	// Resolve tool round limit for this user (tier-ready)
	toolRoundLimit, err := svc.toolLimitResolver.GetToolRoundLimit(ctx, req.UserID)
	if err != nil {
		svc.logger.Warn("failed to get tool round limit, using config default",
			"error", err,
			"user_id", req.UserID,
			"fallback_limit", svc.config.LLM.MaxToolRounds,
		)
		toolRoundLimit = svc.config.LLM.MaxToolRounds
	}
	settlementMode := svc.resolveSettlementMode(p.provider)

	// Get or create interjection buffer for this turn
	interjectionBuffer := svc.interjectionRegistry.GetOrCreate(p.assistantTurn.ID)

	// Create stream switch function for interjection injection
	streamSwitchFn := svc.createStreamSwitchFn(p.threadCtx.threadID, req.UserID, p.requestParams)

	// Create StreamExecutor immediately (before goroutine) to avoid race condition
	// This ensures SSE clients can connect while we're preparing the request
	executor := NewStreamExecutor(
		p.assistantTurn.ID,
		p.threadCtx.threadID,
		req.UserID,
		p.model,
		svc.turnWriter,
		svc.turnReader,
		svc.turnNavigator,
		llmProvider,
		toolRegistry,
		svc.messageBuilder,
		svc.logger,
		svc.creditAdmissionChecker,
		svc.creditSettler,
		settlementMode,
		toolRoundLimit,
		svc.config.Server.Debug,
		svc.tokenFinalizer,
		svc.jobQueue,
		svc.config.LLM.SoftCancelTimeoutSeconds,
		interjectionBuffer,
		streamSwitchFn,
	)

	// Register stream in registry IMMEDIATELY
	// This must happen before returning response to prevent race with SSE connections
	stream := executor.GetStream()
	if err := svc.registry.Register(stream); err != nil {
		svc.logger.Warn("failed to register stream", "turn_id", p.assistantTurn.ID, "error", err)
	}

	// Set cleanup callback BEFORE registering executor
	// This ensures executor is removed from registry when streaming completes/errors
	turnID := p.assistantTurn.ID
	userID := req.UserID
	executor.SetCleanupCallback(func() {
		svc.executorRegistry.Remove(turnID)
		svc.userStreamTracker.Release(userID)
		svc.logger.Debug("executor cleaned up from registry", "turn_id", turnID)
	})
	p.streamAcquired = false // Transfer ownership to cleanup callback

	// Register executor for interruption handling
	svc.executorRegistry.Register(p.assistantTurn.ID, executor)

	svc.logger.Debug("stream registered, starting background streaming",
		"assistant_turn_id", p.assistantTurn.ID,
		"model", p.model,
	)

	// Start streaming in background goroutine
	// Use context.Background() to prevent cancellation when HTTP request completes
	go svc.startStreamingExecution(context.Background(), p.assistantTurn.ID, p.userTurn.ID, req.UserID, p.threadCtx.projectID, executor, p.params)

	// Return both turns and stream URL
	streamURL := fmt.Sprintf("/api/turns/%s/stream", p.assistantTurn.ID)
	return &domainllm.CreateTurnResponse{
		Thread:        p.createdThread, // Only populated on cold start
		UserTurn:      p.userTurn,
		AssistantTurn: p.assistantTurn,
		StreamURL:     streamURL,
	}, nil
}

// buildProductionToolRegistry creates the per-request tool registry with
// project-specific tools and optional web search.
func (p *turnPipeline) buildProductionToolRegistry(thread *domainllm.Thread) *tools.ToolRegistry {
	svc := p.svc

	builder := tools.NewToolRegistryBuilder().
		WithNamespaceService(svc.namespaceSvc).
		WithMutationStrategy(svc.mutationStrategy).
		WithEnabledDocumentTools(p.enabledTools, thread.ProjectID, p.req.UserID, svc.documentSvc, svc.folderSvc).
		WithEnabledSkillTools(p.enabledTools, thread.ProjectID, svc.skillResolver, false, p.availableSkills)

	// Add web search tool if requested via provider-specific tool name.
	// Web-search registration must happen before WithPersonaToolFilter so it can be pruned too.
	requestedTools := p.enabledTools

	if sliceutil.Contains(requestedTools, "tavily_web_search") {
		if svc.config.LLM.SearchAPIKey != "" {
			searchClient := external.NewTavilyClient(svc.config.LLM.SearchAPIKey)
			builder.WithWebSearch(searchClient)

			svc.logger.Debug("per-request tool registry created",
				"project_id", thread.ProjectID,
				"thread_id", p.threadCtx.threadID,
				"assistant_turn_id", p.assistantTurn.ID,
				"web_search_enabled", true,
				"web_search_provider", "tavily",
			)
		} else {
			svc.logger.Warn("tavily_web_search requested but SEARCH_API_KEY not configured")
		}
	} else if sliceutil.Contains(requestedTools, "brave_web_search") {
		svc.logger.Warn("brave_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "serper_web_search") {
		svc.logger.Warn("serper_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "exa_web_search") {
		svc.logger.Warn("exa_web_search requested but not yet implemented")
	} else {
		svc.logger.Debug("per-request tool registry created",
			"project_id", thread.ProjectID,
			"thread_id", p.threadCtx.threadID,
			"assistant_turn_id", p.assistantTurn.ID,
			"web_search_enabled", false,
			"web_search_provider", "",
		)
	}

	// Persona tool filter: prune tools AFTER all are registered (including web search).
	// This mirrors the same filter applied to the temp registry in assemblePrompt.
	if p.resolvedPersona != nil {
		builder.WithPersonaToolFilter(p.resolvedPersona.Tools, p.resolvedPersona.DisallowedTools)
	}

	return builder.Build()
}

// startStreamingExecution starts the streaming execution for an assistant turn.
// This runs in a background goroutine and prepares the request before starting the stream.
// The executor is already created and registered before this function is called.
func (s *Service) startStreamingExecution(ctx context.Context, assistantTurnID, userTurnID, userID, projectID string, executor *StreamExecutor, params *domainllm.RequestParams) {
	s.logger.Debug("preparing streaming request",
		"assistant_turn_id", assistantTurnID,
	)

	// Get conversation history (turn path)
	path, err := s.turnNavigator.GetTurnPath(ctx, userTurnID)
	if err != nil {
		s.logger.Error("failed to get turn path for streaming",
			"error", err,
			"user_turn_id", userTurnID,
		)
		if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to get turn path: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return
	}

	// Load content blocks for all turns in the path
	for i := range path {
		blocks, err := s.turnReader.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			s.logger.Error("failed to get content blocks",
				"error", err,
				"turn_id", path[i].ID,
			)
			if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to get content blocks: %v", err)); updateErr != nil {
				s.logger.Error("failed to update turn error", "error", updateErr)
			}
			return
		}
		path[i].Blocks = blocks
	}

	// Build messages from turn history
	messages, err := s.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		s.logger.Error("failed to build messages for streaming",
			"error", err,
		)
		if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to build messages: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return
	}

	// Post-process: compile @-references into synthetic tool_use/tool_result pairs.
	refTransformer := threadhistory.NewReferenceMessageTransformer(
		s.documentSvc, s.folderSvc, s.formatterRegistry, userID, projectID, s.logger,
	)
	messages, err = refTransformer.TransformMessages(ctx, messages)
	if err != nil {
		s.logger.Error("failed to transform references in messages",
			"error", err,
		)
		if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to transform references: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return
	}

	// Build GenerateRequest
	generateReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    executor.model,
		Params:   params,
	}

	// Start streaming execution (non-blocking)
	executor.Start(generateReq)

	s.logger.Info("streaming execution started",
		"assistant_turn_id", assistantTurnID,
		"model", executor.model,
	)
}
