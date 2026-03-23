package streaming

import (
	"context"
	"fmt"
	"strings"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"

	"meridian/internal/config"
	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/pkg/sliceutil"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tools"
	"meridian/internal/service/llm/tools/external"
)

// CreateTurn creates a new user turn and triggers assistant streaming response.
// Returns both the user turn and the assistant turn for client to connect to SSE stream.
//
// Thread resolution priority:
// 1. If PrevTurnID provided -> lookup its thread_id from DB (ignores ThreadID/ProjectID)
// 2. Else if ThreadID provided -> use that thread
// 3. Else if ProjectID provided -> create new thread (cold start, title from first text block)
// 4. Else -> validation error
func (s *Service) CreateTurn(ctx context.Context, req *domainllm.CreateTurnRequest) (*domainllm.CreateTurnResponse, error) {
	// Normalize empty strings to nil
	if req.PrevTurnID != nil && *req.PrevTurnID == "" {
		req.PrevTurnID = nil
	}
	if req.ThreadID != nil && *req.ThreadID == "" {
		req.ThreadID = nil
	}
	if req.ProjectID != nil && *req.ProjectID == "" {
		req.ProjectID = nil
	}

	// Validate basic request fields (role, turn blocks)
	if err := s.validateCreateTurnRequest(req); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	// Resolve thread context: determine threadID, projectID, and whether we need to create a new thread
	threadContext, err := s.resolveThreadContext(ctx, req)
	if err != nil {
		return nil, err
	}

	// Prepare request params and model before transaction
	requestParams := req.RequestParams
	if requestParams == nil {
		requestParams = make(map[string]interface{})
	}

	// Server-side tool policy enforcement:
	// - Treat project preferences as the source of truth for tool availability.
	// - Ignore any client-sent request_params.tools (no backwards-compat requirement).
	// - Web search is only included if configured on the server.
	project, err := s.projectRepo.GetByID(ctx, threadContext.projectID, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to load project for tool policy: %w", err)
	}

	disabled := parseDisabledTools(project.Preferences)
	toolNames := resolveServerToolNames(s.config.LLM.SearchAPIKey != "", disabled)
	toolsParam, err := toolNamesToRequestParamsTools(toolNames)
	if err != nil {
		return nil, fmt.Errorf("failed to build tools for request params: %w", err)
	}
	requestParams["tools"] = toolsParam

	// Validate request params first
	if err := domainllm.ValidateRequestParams(requestParams); err != nil {
		s.logger.Error("invalid request params", "error", err)
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	params, err := domainllm.GetRequestParamStruct(requestParams)
	if err != nil {
		s.logger.Error("failed to parse request params", "error", err)
		return nil, fmt.Errorf("failed to parse request params: %w", err)
	}

	// Extract model from request_params (pure model name, no provider prefix)
	model := s.config.LLM.DefaultModel
	if model == "" {
		model = "moonshotai/kimi-k2-thinking" // Fallback if config not set
	}
	if params.Model != nil && *params.Model != "" {
		model = *params.Model
	}

	// Extract provider from request_params or infer from model
	var provider string
	if params.Provider != nil && *params.Provider != "" {
		// Provider explicitly specified
		provider = *params.Provider
	} else {
		// Try to infer provider from model name
		if mappedProvider, found := domainllm.GetProviderForModel(model); found {
			provider = mappedProvider
		} else {
			// No mapping found - default to openrouter (has all models)
			provider = "openrouter"
		}
		// Persist resolved provider to request_params for turn history/edit
		// This ensures we always know which provider was actually used
		requestParams["provider"] = provider
	}

	// Filter out tools if model doesn't support them
	// This prevents "No endpoints found that support tool use" errors from providers
	if modelCap, err := s.capabilityRegistry.GetModelCapabilities(provider, model); err == nil {
		if !modelCap.SupportsTools && params.Tools != nil && len(params.Tools) > 0 {
			s.logger.Debug("filtering out tools - model doesn't support tools",
				"provider", provider,
				"model", model,
				"tools_count", len(params.Tools),
			)
			params.Tools = nil
			// Also remove from requestParams to keep them in sync
			delete(requestParams, "tools")
		}

		// Apply provider routing from capabilities (OpenRouter)
		// Only apply if user hasn't explicitly set provider routing in the request
		if modelCap.ProviderRouting != nil {
			// Only apply if not already set by user
			if params.ProviderOrder == nil && len(modelCap.ProviderRouting.Order) > 0 {
				params.ProviderOrder = modelCap.ProviderRouting.Order
				requestParams["provider_order"] = modelCap.ProviderRouting.Order
			}
			if params.ProviderIgnore == nil && len(modelCap.ProviderRouting.Ignore) > 0 {
				params.ProviderIgnore = modelCap.ProviderRouting.Ignore
				requestParams["provider_ignore"] = modelCap.ProviderRouting.Ignore
			}
			if params.ProviderOnly == nil && len(modelCap.ProviderRouting.Only) > 0 {
				params.ProviderOnly = modelCap.ProviderRouting.Only
				requestParams["provider_only"] = modelCap.ProviderRouting.Only
			}
			if params.AllowFallbacks == nil && modelCap.ProviderRouting.AllowFallbacks != nil {
				params.AllowFallbacks = modelCap.ProviderRouting.AllowFallbacks
				requestParams["allow_fallbacks"] = *modelCap.ProviderRouting.AllowFallbacks
			}
			if params.ProviderSort == nil && modelCap.ProviderRouting.Sort != nil {
				params.ProviderSort = modelCap.ProviderRouting.Sort
				requestParams["provider_sort"] = *modelCap.ProviderRouting.Sort
			}
		}
	} else {
		// Model not found in registry - log warning but continue (fail-open)
		s.logger.Warn("model not found in capability registry, skipping tool filter",
			"provider", provider,
			"model", model,
			"error", err,
		)
	}

	// Enforce per-user concurrent stream limit before committing resources.
	// Paid users (purchased_balance > 0) get a higher limit.
	// Ownership transfers to the cleanup callback after executor registration.
	hasPurchased := s.creditAdmissionChecker.HasPurchasedCredits(ctx, req.UserID)
	if err := s.userStreamTracker.Acquire(req.UserID, hasPurchased); err != nil {
		return nil, err
	}
	streamAcquired := true
	defer func() {
		if streamAcquired {
			// Release if we return early (error paths) before ownership transfers to cleanup
			s.userStreamTracker.Release(req.UserID)
		}
	}()

	// Extract enabled tools from requestParams for tool registration
	enabledTools := extractToolNames(requestParams)

	// Load skills once for tool metadata enrichment (shared across both registries).
	// Skills metadata is now owned by the tool system (not the system prompt resolver)
	// so it's naturally excluded when the model doesn't support tools.
	availableSkills, err := s.skillService.ListSkills(ctx, req.UserID, threadContext.projectID)
	if err != nil {
		s.logger.Warn("failed to load skills for tool metadata", "error", err)
		availableSkills = nil // Continue without skills — non-fatal
	}

	// Build tool registry FIRST to generate tool section for system prompt (OCP compliance)
	// Tools self-describe via metadata, registry generates the section dynamically
	tempToolRegistry := tools.NewToolRegistryBuilder().
		WithNamespaceService(s.namespaceSvc).
		WithMutationStrategy(s.mutationStrategy).
		WithEnabledDocumentTools(enabledTools, threadContext.projectID, req.UserID, s.documentSvc, s.folderSvc).
		WithEnabledSkillTools(enabledTools, threadContext.projectID, req.UserID, s.skillService, false, availableSkills).
		Build()

	// Get tool section from registry (OCP compliance - tools describe themselves)
	toolSection := tempToolRegistry.BuildSystemPromptSection()

	// Resolve system prompt from user, project, thread, and selected skills
	// For new thread (cold start), threadContext.threadID will be empty - resolver handles this gracefully
	// Pass toolSection so the system prompt only mentions tools the LLM can actually use
	if err := s.resolveSystemPromptForParams(ctx, threadContext.threadID, threadContext.projectID, req.UserID, params, req.SelectedSkills, toolSection); err != nil {
		s.logger.Error("failed to resolve system prompt", "error", err)
		return nil, err
	}

	// Create user turn + blocks and assistant turn atomically in a transaction
	// If cold start, also create the thread in the same transaction
	var turn *domainllm.Turn
	var assistantTurn *domainllm.Turn
	var createdThread *domainllm.Thread // Only set if we created a new thread
	now := time.Now().UTC()

	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// If cold start, create the thread first
		if threadContext.isNewThread {
			title := deriveTitleFromTurnBlocks(req.TurnBlocks)
			createdThread = &domainllm.Thread{
				ProjectID: threadContext.projectID,
				UserID:    req.UserID,
				Title:     title,
				CreatedAt: now,
				UpdatedAt: now,
			}
			if err := s.threadRepo.CreateThread(txCtx, createdThread); err != nil {
				return fmt.Errorf("failed to create thread: %w", err)
			}
			// Update threadContext with the new thread ID
			threadContext.threadID = createdThread.ID

			s.logger.Debug("thread created (cold start)",
				"id", createdThread.ID,
				"title", createdThread.Title,
				"project_id", threadContext.projectID,
				"user_id", req.UserID,
			)
		}

		// Create user turn
		// Store request_params on user turn so it's available when editing
		turn = &domainllm.Turn{
			ThreadID:      threadContext.threadID,
			PrevTurnID:    req.PrevTurnID,
			Role:          req.Role,
			Status:        domainllm.TurnStatusComplete, // User turn is immediately complete
			RequestParams: requestParams,
			CreatedAt:     now,
		}

		if err := s.turnWriter.CreateTurn(txCtx, turn); err != nil {
			return err
		}

		// Create content blocks if provided
		if len(req.TurnBlocks) > 0 {
			blocks := make([]domainllm.TurnBlock, len(req.TurnBlocks))
			for i, blockInput := range req.TurnBlocks {
				blocks[i] = domainllm.TurnBlock{
					TurnID:      turn.ID,
					BlockType:   blockInput.BlockType,
					Sequence:    i,
					TextContent: blockInput.TextContent,
					Content:     blockInput.Content, // nil becomes NULL in database
					CreatedAt:   now,
				}
			}

			if err := s.turnWriter.CreateTurnBlocks(txCtx, blocks); err != nil {
				return err
			}

			// Attach content blocks to turn
			turn.Blocks = blocks
		}

		// Create assistant turn with status="streaming"
		assistantTurn = &domainllm.Turn{
			ThreadID:      threadContext.threadID,
			PrevTurnID:    &turn.ID, // Assistant turn follows user turn
			Role:          "assistant",
			Status:        domainllm.TurnStatusStreaming,
			Model:         &model,
			RequestParams: requestParams,
			CreatedAt:     time.Now().UTC(),
		}

		if err := s.turnWriter.CreateTurn(txCtx, assistantTurn); err != nil {
			return fmt.Errorf("failed to create assistant turn: %w", err)
		}

		// Touch project activity (non-fatal - don't fail turn creation for metadata updates)
		if err := s.projectRepo.TouchLastActivityAt(txCtx, threadContext.projectID); err != nil {
			s.logger.Warn("failed to touch project activity",
				"project_id", threadContext.projectID,
				"error", err,
			)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	s.logger.Info("user turn created",
		"id", turn.ID,
		"thread_id", threadContext.threadID,
		"role", req.Role,
		"prev_turn_id", req.PrevTurnID,
		"turn_blocks", len(req.TurnBlocks),
		"is_cold_start", threadContext.isNewThread,
	)

	s.logger.Info("assistant turn created with streaming status",
		"user_turn_id", turn.ID,
		"assistant_turn_id", assistantTurn.ID,
		"model", model,
		"provider", provider,
	)

	// Get thread to extract project_id for tools
	// If we just created the thread (cold start), use createdThread; otherwise fetch it
	var thread *domainllm.Thread
	if createdThread != nil {
		thread = createdThread
	} else {
		var threadErr error
		thread, threadErr = s.threadRepo.GetThread(ctx, threadContext.threadID, req.UserID)
		if threadErr != nil {
			s.logger.Error("failed to get thread for tools",
				"error", threadErr,
				"thread_id", threadContext.threadID,
				"user_id", req.UserID,
			)
			// Update turn to error status
			if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurn.ID, fmt.Sprintf("failed to get thread: %v", threadErr)); updateErr != nil {
				s.logger.Error("failed to update turn error", "error", updateErr)
			}
			return nil, fmt.Errorf("failed to get thread for tools: %w", threadErr)
		}
	}

	// Create per-request tool registry with project-specific tools
	// All tools use service layer (SOLID compliance, Phase 4: zero repo dependencies)
	// Use filtered builder methods to only register tools that are actually enabled
	builder := tools.NewToolRegistryBuilder().
		WithNamespaceService(s.namespaceSvc).
		WithMutationStrategy(s.mutationStrategy).
		WithEnabledDocumentTools(enabledTools, thread.ProjectID, req.UserID, s.documentSvc, s.folderSvc).
		WithEnabledSkillTools(enabledTools, thread.ProjectID, req.UserID, s.skillService, false, availableSkills) // false = model invocation, not user slash command

	// Add web search tool if requested via provider-specific tool name
	var hasWebSearch bool
	var webSearchProvider string

	// requestedTools already extracted as enabledTools above
	requestedTools := enabledTools

	// Check for provider-specific web search tools
	if sliceutil.Contains(requestedTools, "tavily_web_search") {
		if s.config.LLM.SearchAPIKey != "" {
			searchClient := external.NewTavilyClient(s.config.LLM.SearchAPIKey)
			builder.WithWebSearch(searchClient)
			hasWebSearch = true
			webSearchProvider = "tavily"
		} else {
			s.logger.Warn("tavily_web_search requested but SEARCH_API_KEY not configured")
		}
	} else if sliceutil.Contains(requestedTools, "brave_web_search") {
		// Future: Brave implementation
		s.logger.Warn("brave_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "serper_web_search") {
		// Future: Serper implementation
		s.logger.Warn("serper_web_search requested but not yet implemented")
	} else if sliceutil.Contains(requestedTools, "exa_web_search") {
		// Future: Exa implementation
		s.logger.Warn("exa_web_search requested but not yet implemented")
	}

	toolRegistry := builder.Build()

	s.logger.Debug("per-request tool registry created",
		"project_id", thread.ProjectID,
		"thread_id", threadContext.threadID,
		"assistant_turn_id", assistantTurn.ID,
		"web_search_enabled", hasWebSearch,
		"web_search_provider", webSearchProvider,
	)

	// Get provider adapter (do this synchronously to avoid race)
	llmProvider, err := s.providerGetter.GetProvider(provider)
	if err != nil {
		s.logger.Error("failed to get provider for streaming",
			"error", err,
			"provider", provider,
			"model", model,
			"assistant_turn_id", assistantTurn.ID,
		)
		// Update turn to error status
		if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurn.ID, fmt.Sprintf("failed to get provider: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return nil, fmt.Errorf("failed to get provider '%s': %w", provider, err)
	}

	// Resolve tool round limit for this user (tier-ready)
	toolRoundLimit, err := s.toolLimitResolver.GetToolRoundLimit(ctx, req.UserID)
	if err != nil {
		// Log warning and fall back to config default
		s.logger.Warn("failed to get tool round limit, using config default",
			"error", err,
			"user_id", req.UserID,
			"fallback_limit", s.config.LLM.MaxToolRounds,
		)
		toolRoundLimit = s.config.LLM.MaxToolRounds
	}
	settlementMode := s.resolveSettlementMode(provider)

	// Get or create interjection buffer for this turn
	interjectionBuffer := s.interjectionRegistry.GetOrCreate(assistantTurn.ID)

	// Create stream switch function for interjection injection
	// This is called when an interjection needs to be injected (tool boundary or completion)
	streamSwitchFn := s.createStreamSwitchFn(threadContext.threadID, req.UserID, requestParams)

	// Create StreamExecutor immediately (before goroutine) to avoid race condition
	// This ensures SSE clients can connect while we're preparing the request
	executor := NewStreamExecutor(
		assistantTurn.ID,
		threadContext.threadID, // Thread ID for AG-UI events
		req.UserID,             // User who initiated this turn (for tool provenance)
		model,                  // Pure model name (no provider prefix)
		s.turnWriter,           // TurnWriter
		s.turnReader,           // TurnReader
		s.turnNavigator,        // TurnNavigator (for continuation path loading)
		llmProvider,            // Provider adapter
		toolRegistry,           // Per-request ToolRegistry with project-specific tools
		s.messageBuilder,       // MessageBuilder (for continuation message building)
		s.logger,
		s.creditAdmissionChecker,
		s.creditSettler,
		settlementMode,
		toolRoundLimit,                        // Per-user tool round limit (tier-ready)
		s.config.Server.Debug,                 // Pass DEBUG flag for optional event IDs
		s.tokenFinalizer,                      // For finalizing tokens on completion/interruption
		s.jobQueue,                            // Phase 2: Background job queue for async generation enrichment
		s.config.LLM.SoftCancelTimeoutSeconds, // Timeout for soft cancel cleanup (default: 5 minutes)
		interjectionBuffer,                    // For user interjections during streaming
		streamSwitchFn,                        // Callback for stream switch on interjection
	)

	// Register stream in registry IMMEDIATELY
	// This must happen before returning response to prevent race with SSE connections
	stream := executor.GetStream()
	if err := s.registry.Register(stream); err != nil {
		s.logger.Warn("failed to register stream", "turn_id", assistantTurn.ID, "error", err)
	}

	// Set cleanup callback BEFORE registering executor
	// This ensures executor is removed from registry when streaming completes/errors
	turnID := assistantTurn.ID // Capture for closure
	userID := req.UserID       // Capture for closure
	executor.SetCleanupCallback(func() {
		s.executorRegistry.Remove(turnID)
		s.userStreamTracker.Release(userID)
		s.logger.Debug("executor cleaned up from registry", "turn_id", turnID)
	})
	streamAcquired = false // Transfer ownership to cleanup callback

	// Register executor for interruption handling
	s.executorRegistry.Register(assistantTurn.ID, executor)

	s.logger.Debug("stream registered, starting background streaming",
		"assistant_turn_id", assistantTurn.ID,
		"model", model,
	)

	// Start streaming in background goroutine
	// Use context.Background() to prevent cancellation when HTTP request completes
	// Pass the already-created executor to avoid race
	go s.startStreamingExecution(context.Background(), assistantTurn.ID, turn.ID, req.UserID, threadContext.projectID, executor, params)

	// Return both turns and stream URL
	// If cold start, also return the created thread
	streamURL := fmt.Sprintf("/api/turns/%s/stream", assistantTurn.ID)
	return &domainllm.CreateTurnResponse{
		Thread:        createdThread, // Only populated on cold start
		UserTurn:      turn,
		AssistantTurn: assistantTurn,
		StreamURL:     streamURL,
	}, nil
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
	// This makes references look like prior tool calls, so LLMs don't redundantly
	// call str_replace_based_edit_tool view to re-fetch the same data.
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

	// Note: StreamExecutor will:
	// - Stream from provider
	// - Accumulate deltas into TurnBlocks
	// - Broadcast events via mstream
	// - Update turn status on completion/error
	// - Registry will clean up stream after retention period
}

func (s *Service) resolveSettlementMode(provider string) billing.CreditSettlementMode {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openrouter":
		return billing.CreditSettlementDeferredToEnrichment
	case "anthropic":
		return billing.CreditSettlementInlineAuthoritative
	default:
		if s.settlementMode != "" {
			return s.settlementMode
		}
		return billing.CreditSettlementInlineAuthoritative
	}
}

// CreateAssistantTurnDebug creates an assistant turn (DEBUG/INTERNAL USE ONLY)
//
// WARNING: This method is exposed for:
// 1. Debug handlers (ENVIRONMENT=dev only)
// 2. Internal LLM response generator (Phase 2)
//
// It bypasses the "user" role validation that the public CreateTurn endpoint enforces.
//
// Usage:
//
//	turn, err := s.CreateAssistantTurnDebug(ctx, threadID, userTurnID, blocks, "claude-haiku-4-5-20251001")
//
// The ProviderResolver should:
// 1. Call this to create assistant turn with status="streaming"
// 2. Stream response chunks and append content blocks incrementally
// 3. Update turn status to "complete" when done
func (s *Service) CreateAssistantTurnDebug(
	ctx context.Context,
	threadID string,
	userID string,
	prevTurnID *string,
	contentBlocks []domainllm.TurnBlockInput,
	model string,
) (*domainllm.Turn, error) {
	// Validate thread exists and is not deleted
	if err := s.validator.ValidateThread(ctx, threadID, userID); err != nil {
		return nil, err
	}

	// Validate prev turn exists if provided
	if prevTurnID != nil {
		_, err := s.turnReader.GetTurn(ctx, *prevTurnID)
		if err != nil {
			return nil, err
		}
	}

	// Create assistant turn
	now := time.Now().UTC()
	turn := &domainllm.Turn{
		ThreadID:   threadID,
		PrevTurnID: prevTurnID,
		Role:       "assistant",
		Status:     domainllm.TurnStatusStreaming, // Start as streaming
		Model:      &model,
		CreatedAt:  now,
	}

	if err := s.turnWriter.CreateTurn(ctx, turn); err != nil {
		return nil, err
	}

	// Create initial content blocks if provided
	if len(contentBlocks) > 0 {
		blocks := make([]domainllm.TurnBlock, len(contentBlocks))
		for i, blockInput := range contentBlocks {
			blocks[i] = domainllm.TurnBlock{
				TurnID:      turn.ID,
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content,
				CreatedAt:   now,
			}
		}

		if err := s.turnWriter.CreateTurnBlocks(ctx, blocks); err != nil {
			return nil, err
		}

		turn.Blocks = blocks
	}

	s.logger.Debug("assistant turn created (internal)",
		"id", turn.ID,
		"thread_id", threadID,
		"prev_turn_id", prevTurnID,
		"model", model,
		"turn_blocks", len(contentBlocks),
	)

	return turn, nil
}

// resolveSystemPromptForParams resolves system prompt from multiple sources and updates params.
// This consolidates logic shared between CreateTurn and BuildDebugProviderRequest.
//
// Resolution order (all concatenated):
// 1. Base prompt (Meridian identity) + tool section (from toolSection parameter)
// 2. User-provided system prompt (from params.System)
// 3. Project system prompt
// 4. Thread system prompt
// 5. Selected skills (loaded from DB via skill service)
//
// This method ALWAYS calls the resolver to ensure base/project/thread prompts
// are included even when a user system prompt is provided.
//
// toolSection is a pre-built string describing available tools and guidelines.
// This is generated by ToolRegistry.BuildSystemPromptSection() to enable OCP compliance:
// tools self-describe via metadata, and the registry generates the section dynamically.
func (s *Service) resolveSystemPromptForParams(
	ctx context.Context,
	threadID string,
	projectID string,
	userID string,
	params *domainllm.RequestParams,
	selectedSkills []string,
	toolSection string,
) error {
	// Always resolve to include base + project + thread system prompts
	// The resolver handles concatenation: base (with tool section) + user + project + thread + skills
	systemPrompt, err := s.systemPromptResolver.Resolve(ctx, threadID, projectID, userID, params.System, selectedSkills, toolSection)
	if err != nil {
		return fmt.Errorf("failed to resolve system prompt: %w", err)
	}
	// Set resolved system prompt in params (concatenated result)
	if systemPrompt != nil {
		s.logger.Debug("final system prompt for LLM",
			"length", len(*systemPrompt),
			"tool_section_length", len(toolSection),
		)
		params.System = systemPrompt
	}
	return nil
}

// Thread resolution types and methods

// threadContext holds resolved thread information for turn creation
type threadContext struct {
	threadID    string // Resolved thread ID (may be empty if isNewThread=true until thread is created)
	projectID   string // Project ID (always set)
	isNewThread bool   // True if we need to create a new thread (cold start)
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
		// Validate user has access to project
		_, err := s.projectRepo.GetByID(ctx, *req.ProjectID, req.UserID)
		if err != nil {
			return nil, fmt.Errorf("project_id references inaccessible project: %w", err)
		}

		return &threadContext{
			threadID:    "", // Will be set after thread creation
			projectID:   *req.ProjectID,
			isNewThread: true,
		}, nil
	}

	// Case 4: None provided - error
	return nil, domain.NewValidationError("must provide thread_id, project_id, or prev_turn_id")
}

// Validation methods

func (s *Service) validateCreateTurnRequest(req *domainllm.CreateTurnRequest) error {
	// Note: ThreadID validation is handled by resolveThreadContext, not here
	return validation.ValidateStruct(req,
		validation.Field(&req.Role,
			validation.Required,
			validation.In("user"), // Only allow user role from client (assistant turns created internally)
		),
		validation.Field(&req.TurnBlocks, validation.Each(validation.By(s.validateTurnBlock))),
	)
}

func (s *Service) validateTurnBlock(value interface{}) error {
	block, ok := value.(domainllm.TurnBlockInput)
	if !ok {
		return fmt.Errorf("invalid content block type")
	}

	if block.BlockType == "" {
		return fmt.Errorf("block_type is required")
	}

	// Support all block types: user and assistant
	validTypes := []string{
		"text", "thinking", "tool_use", "tool_result",
		"image", "reference", "partial_reference",
	}
	isValid := false
	for _, validType := range validTypes {
		if block.BlockType == validType {
			isValid = true
			break
		}
	}

	if !isValid {
		return fmt.Errorf("block_type must be one of: %v", validTypes)
	}

	// Validate content structure based on block type using typed schemas
	if err := domainllm.ValidateContent(block.BlockType, block.Content); err != nil {
		return fmt.Errorf("invalid content for %s block: %w", block.BlockType, err)
	}

	return nil
}

// extractToolNames extracts tool names from request params
// Handles both minimal format {"name": "tool"} and full format {"function": {"name": "tool"}}
func extractToolNames(requestParams map[string]interface{}) []string {
	toolNames := []string{}

	// Extract "tools" array from request params
	toolsRaw, ok := requestParams["tools"]
	if !ok {
		return toolNames
	}

	tools, ok := toolsRaw.([]interface{})
	if !ok {
		return toolNames
	}

	for _, toolRaw := range tools {
		toolMap, ok := toolRaw.(map[string]interface{})
		if !ok {
			continue
		}

		// Check minimal format: {"name": "tool"}
		if name, ok := toolMap["name"].(string); ok {
			toolNames = append(toolNames, name)
			continue
		}

		// Check full format: {"function": {"name": "tool"}}
		if functionRaw, ok := toolMap["function"]; ok {
			if functionMap, ok := functionRaw.(map[string]interface{}); ok {
				if name, ok := functionMap["name"].(string); ok {
					toolNames = append(toolNames, name)
				}
			}
		}
	}

	return toolNames
}

// deriveTitleFromTurnBlocks extracts a title from the first text block content.
// Used for cold start thread creation where title is derived from user's first message.
// Returns first N words (default 6), truncated at MaxThreadTitleLength if needed.
const defaultTitleMaxWords = 6

func deriveTitleFromTurnBlocks(blocks []domainllm.TurnBlockInput) string {
	// Find first text block with content
	for _, block := range blocks {
		if block.BlockType == "text" && block.TextContent != nil {
			text := strings.TrimSpace(*block.TextContent)
			if text != "" {
				return truncateTitleFromText(text)
			}
		}
	}
	return "New Thread"
}

// truncateTitleFromText extracts first N words and truncates to max length
func truncateTitleFromText(text string) string {
	words := strings.Fields(text)
	if len(words) > defaultTitleMaxWords {
		words = words[:defaultTitleMaxWords]
	}

	title := strings.Join(words, " ")

	// Truncate if exceeds max length
	if len(title) > config.MaxThreadTitleLength {
		title = title[:config.MaxThreadTitleLength-3] + "..."
	}

	return title
}

