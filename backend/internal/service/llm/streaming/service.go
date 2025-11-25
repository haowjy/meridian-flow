package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/tools"
	"meridian/internal/service/llm/tools/external"
)

// ChatValidator is shared validation logic for chat operations
type ChatValidator interface {
	ValidateChat(ctx context.Context, chatID, userID string) error
}

// LLMProviderGetter provides access to LLM providers by model name
type LLMProviderGetter interface {
	GetProvider(model string) (llmSvc.LLMProvider, error)
}

// Service implements the StreamingService interface
// Handles turn creation and streaming orchestration
// Uses minimal interfaces (ISP compliance): TurnWriter for creating turns, TurnReader for reading blocks
type Service struct {
	turnWriter           llmRepo.TurnWriter
	turnReader           llmRepo.TurnReader
	turnNavigator        llmRepo.TurnNavigator
	chatRepo             llmRepo.ChatRepository
	documentRepo         docsysRepo.DocumentRepository
	folderRepo           docsysRepo.FolderRepository
	validator            ChatValidator
	providerGetter       LLMProviderGetter
	registry             *mstream.Registry
	config               *config.Config
	txManager            repositories.TransactionManager
	systemPromptResolver llmSvc.SystemPromptResolver
	messageBuilder       llmSvc.MessageBuilder
	logger               *slog.Logger
}

// NewService creates a new streaming service
func NewService(
	turnWriter           llmRepo.TurnWriter,
	turnReader           llmRepo.TurnReader,
	turnNavigator        llmRepo.TurnNavigator,
	chatRepo             llmRepo.ChatRepository,
	documentRepo         docsysRepo.DocumentRepository,
	folderRepo           docsysRepo.FolderRepository,
	validator            ChatValidator,
	providerGetter       LLMProviderGetter,
	registry             *mstream.Registry,
	cfg                  *config.Config,
	txManager            repositories.TransactionManager,
	systemPromptResolver llmSvc.SystemPromptResolver,
	messageBuilder       llmSvc.MessageBuilder,
	logger               *slog.Logger,
) llmSvc.StreamingService {
	return &Service{
		turnWriter:           turnWriter,
		turnReader:           turnReader,
		turnNavigator:        turnNavigator,
		chatRepo:             chatRepo,
		documentRepo:         documentRepo,
		folderRepo:           folderRepo,
		validator:            validator,
		providerGetter:       providerGetter,
		registry:             registry,
		config:               cfg,
		txManager:            txManager,
		systemPromptResolver: systemPromptResolver,
		messageBuilder:       messageBuilder,
		logger:               logger,
	}
}

// CreateTurn creates a new user turn and triggers assistant streaming response.
// Returns both the user turn and the assistant turn for client to connect to SSE stream.
func (s *Service) CreateTurn(ctx context.Context, req *llmSvc.CreateTurnRequest) (*llmSvc.CreateTurnResponse, error) {
	// Normalize empty string to nil for prev_turn_id
	if req.PrevTurnID != nil && *req.PrevTurnID == "" {
		req.PrevTurnID = nil
	}

	// Validate request
	if err := s.validateCreateTurnRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Validate chat exists and is not deleted
	if err := s.validator.ValidateChat(ctx, req.ChatID, req.UserID); err != nil {
		return nil, err
	}

	// Prepare request params and model before transaction
	requestParams := req.RequestParams
	if requestParams == nil {
		requestParams = make(map[string]interface{})
	}

	// Validate request params first
	if err := llmModels.ValidateRequestParams(requestParams); err != nil {
		s.logger.Error("invalid request params", "error", err)
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	params, err := llmModels.GetRequestParamStruct(requestParams)
	if err != nil {
		s.logger.Error("failed to parse request params", "error", err)
		return nil, fmt.Errorf("failed to parse request params: %w", err)
	}

	// Extract model from request_params (pure model name, no provider prefix)
	model := s.config.DefaultModel
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
		if mappedProvider, found := llmModels.GetProviderForModel(model); found {
			provider = mappedProvider
		} else {
			// No mapping found - default to openrouter (has all models)
			provider = "openrouter"
		}
	}

	// Resolve system prompt from user, project, chat, and selected skills
	// Always resolve if skills are selected, or if no user system prompt provided
	if err := s.resolveSystemPromptForParams(ctx, req.ChatID, req.UserID, params, req.SelectedSkills); err != nil {
		s.logger.Error("failed to resolve system prompt", "error", err)
		return nil, err
	}

	// Create user turn + blocks and assistant turn atomically in a transaction
	var turn *llmModels.Turn
	var assistantTurn *llmModels.Turn
	now := time.Now()

	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// Create user turn
		turn = &llmModels.Turn{
			ChatID:     req.ChatID,
			PrevTurnID: req.PrevTurnID,
			Role:       req.Role,
			Status:     "complete", // User turn is immediately complete
			CreatedAt:  now,
		}

		if err := s.turnWriter.CreateTurn(txCtx, turn); err != nil {
			return err
		}

		// Create content blocks if provided
		if len(req.TurnBlocks) > 0 {
			blocks := make([]llmModels.TurnBlock, len(req.TurnBlocks))
			for i, blockInput := range req.TurnBlocks {
				blocks[i] = llmModels.TurnBlock{
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
		assistantTurn = &llmModels.Turn{
			ChatID:        req.ChatID,
			PrevTurnID:    &turn.ID, // Assistant turn follows user turn
			Role:          "assistant",
			Status:        "streaming",
			Model:         &model,
			RequestParams: requestParams,
			CreatedAt:     time.Now(),
		}

		if err := s.turnWriter.CreateTurn(txCtx, assistantTurn); err != nil {
			return fmt.Errorf("failed to create assistant turn: %w", err)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	s.logger.Info("user turn created",
		"id", turn.ID,
		"chat_id", req.ChatID,
		"role", req.Role,
		"prev_turn_id", req.PrevTurnID,
		"turn_blocks", len(req.TurnBlocks),
	)

	s.logger.Info("assistant turn created with streaming status",
		"user_turn_id", turn.ID,
		"assistant_turn_id", assistantTurn.ID,
		"model", model,
		"provider", provider,
	)

	// Get chat to extract project_id for tools
	chat, err := s.chatRepo.GetChat(ctx, req.ChatID, req.UserID)
	if err != nil {
		s.logger.Error("failed to get chat for tools",
			"error", err,
			"chat_id", req.ChatID,
			"user_id", req.UserID,
		)
		// Update turn to error status
		if updateErr := s.turnWriter.UpdateTurnError(ctx, assistantTurn.ID, fmt.Sprintf("failed to get chat: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return nil, fmt.Errorf("failed to get chat for tools: %w", err)
	}

	// Create per-request tool registry with project-specific tools
	builder := tools.NewToolRegistryBuilder().
		WithDocumentTools(chat.ProjectID, s.documentRepo, s.folderRepo)

	// Add web search tool if requested via provider-specific tool name
	var hasWebSearch bool
	var webSearchProvider string

	// Extract tools from request params
	requestedTools := extractToolNames(requestParams)

	// Check for provider-specific web search tools
	if contains(requestedTools, "tavily_web_search") {
		if s.config.SearchAPIKey != "" {
			searchClient := external.NewTavilyClient(s.config.SearchAPIKey)
			builder.WithWebSearch(searchClient)
			hasWebSearch = true
			webSearchProvider = "tavily"
		} else {
			s.logger.Warn("tavily_web_search requested but SEARCH_API_KEY not configured")
		}
	} else if contains(requestedTools, "brave_web_search") {
		// Future: Brave implementation
		s.logger.Warn("brave_web_search requested but not yet implemented")
	} else if contains(requestedTools, "serper_web_search") {
		// Future: Serper implementation
		s.logger.Warn("serper_web_search requested but not yet implemented")
	} else if contains(requestedTools, "exa_web_search") {
		// Future: Exa implementation
		s.logger.Warn("exa_web_search requested but not yet implemented")
	}

	toolRegistry := builder.Build()

	s.logger.Info("per-request tool registry created",
		"project_id", chat.ProjectID,
		"chat_id", req.ChatID,
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

	// Create StreamExecutor immediately (before goroutine) to avoid race condition
	// This ensures SSE clients can connect while we're preparing the request
	executor := NewStreamExecutor(
		assistantTurn.ID,
		model,            // Pure model name (no provider prefix)
		s.turnWriter,     // TurnWriter
		s.turnReader,     // TurnReader
		s.turnNavigator,       // TurnNavigator (for continuation path loading)
		llmProvider,           // Provider adapter
		toolRegistry,          // Per-request ToolRegistry with project-specific tools
		s.messageBuilder,      // MessageBuilder (for continuation message building)
		s.logger,
		s.config.MaxToolRounds, // Maximum tool execution rounds (configurable via MAX_TOOL_ROUNDS env)
		s.config.Debug,        // Pass DEBUG flag for optional event IDs
	)

	// Register stream in registry IMMEDIATELY
	// This must happen before returning response to prevent race with SSE connections
	stream := executor.GetStream()
	s.registry.Register(stream)

	s.logger.Info("stream registered, starting background streaming",
		"assistant_turn_id", assistantTurn.ID,
		"model", model,
	)

	// Start streaming in background goroutine
	// Use context.Background() to prevent cancellation when HTTP request completes
	// Pass the already-created executor to avoid race
	go s.startStreamingExecution(context.Background(), assistantTurn.ID, turn.ID, executor, params)

	// Return both turns and stream URL
	streamURL := fmt.Sprintf("/api/turns/%s/stream", assistantTurn.ID)
	return &llmSvc.CreateTurnResponse{
		UserTurn:      turn,
		AssistantTurn: assistantTurn,
		StreamURL:     streamURL,
	}, nil
}

// startStreamingExecution starts the streaming execution for an assistant turn.
// This runs in a background goroutine and prepares the request before starting the stream.
// The executor is already created and registered before this function is called.
func (s *Service) startStreamingExecution(ctx context.Context, assistantTurnID, userTurnID string, executor *StreamExecutor, params *llmModels.RequestParams) {
	s.logger.Info("preparing streaming request",
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

	// Build messages from turn history using MessageBuilder
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

	// Build GenerateRequest
	generateReq := &llmSvc.GenerateRequest{
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
//	turn, err := s.CreateAssistantTurnDebug(ctx, chatID, userTurnID, blocks, "claude-haiku-4-5-20251001")
//
// The ResponseGenerator should:
// 1. Call this to create assistant turn with status="streaming"
// 2. Stream response chunks and append content blocks incrementally
// 3. Update turn status to "complete" when done
func (s *Service) CreateAssistantTurnDebug(
	ctx context.Context,
	chatID string,
	userID string,
	prevTurnID *string,
	contentBlocks []llmSvc.TurnBlockInput,
	model string,
) (*llmModels.Turn, error) {
	// Validate chat exists and is not deleted
	if err := s.validator.ValidateChat(ctx, chatID, userID); err != nil {
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
	now := time.Now()
	turn := &llmModels.Turn{
		ChatID:     chatID,
		PrevTurnID: prevTurnID,
		Role:       "assistant",
		Status:     "streaming", // Start as streaming
		Model:      &model,
		CreatedAt:  now,
	}

	if err := s.turnWriter.CreateTurn(ctx, turn); err != nil {
		return nil, err
	}

	// Create initial content blocks if provided
	if len(contentBlocks) > 0 {
		blocks := make([]llmModels.TurnBlock, len(contentBlocks))
		for i, blockInput := range contentBlocks {
			blocks[i] = llmModels.TurnBlock{
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

	s.logger.Info("assistant turn created (internal)",
		"id", turn.ID,
		"chat_id", chatID,
		"prev_turn_id", prevTurnID,
		"model", model,
		"turn_blocks", len(contentBlocks),
	)

	return turn, nil
}

// resolveSystemPromptForParams resolves system prompt from multiple sources and updates params.
// This consolidates logic shared between CreateTurn and BuildDebugProviderRequest.
//
// Resolution order:
// 1. User-provided system prompt (from params.System)
// 2. Project system prompt
// 3. Chat system prompt
// 4. Selected skills (from .skills/{skillName}/SKILL documents)
//
// The method only resolves when:
// - Skills are selected (len(selectedSkills) > 0), OR
// - No user system prompt is provided (params.System == nil)
func (s *Service) resolveSystemPromptForParams(
	ctx context.Context,
	chatID string,
	userID string,
	params *llmModels.RequestParams,
	selectedSkills []string,
) error {
	if len(selectedSkills) > 0 || params.System == nil {
		systemPrompt, err := s.systemPromptResolver.Resolve(ctx, chatID, userID, params.System, selectedSkills)
		if err != nil {
			return fmt.Errorf("failed to resolve system prompt: %w", err)
		}
		// Set resolved system prompt in params (concatenated result)
		if systemPrompt != nil {
			params.System = systemPrompt
		}
	}
	return nil
}

// Validation methods

func (s *Service) validateCreateTurnRequest(req *llmSvc.CreateTurnRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ChatID, validation.Required),
		validation.Field(&req.Role,
			validation.Required,
			validation.In("user"), // Only allow user role from client (assistant turns created internally)
		),
		validation.Field(&req.TurnBlocks, validation.Each(validation.By(s.validateTurnBlock))),
	)
}

func (s *Service) validateTurnBlock(value interface{}) error {
	block, ok := value.(llmSvc.TurnBlockInput)
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
	if err := llmModels.ValidateContent(block.BlockType, block.Content); err != nil {
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

// contains checks if a slice contains a string
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
