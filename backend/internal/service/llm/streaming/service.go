package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"

	"meridian/internal/config"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/domain/repositories"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
)

// ChatValidator is shared validation logic for chat operations
type ChatValidator interface {
	ValidateChat(ctx context.Context, chatID, userID string) error
}

// Service implements the StreamingService interface
// Handles turn creation and streaming orchestration
type Service struct {
	turnRepo          llmRepo.TurnRepository
	validator         ChatValidator
	responseGenerator *ResponseGenerator
	registry          *TurnExecutorRegistry
	config            *config.Config
	txManager         repositories.TransactionManager
	logger            *slog.Logger
}

// NewService creates a new streaming service
func NewService(
	turnRepo llmRepo.TurnRepository,
	validator ChatValidator,
	responseGenerator *ResponseGenerator,
	registry          *TurnExecutorRegistry,
	cfg               *config.Config,
	txManager         repositories.TransactionManager,
	logger            *slog.Logger,
) llmSvc.StreamingService {
	return &Service{
		turnRepo:          turnRepo,
		validator:         validator,
		responseGenerator: responseGenerator,
		registry:          registry,
		config:            cfg,
		txManager:         txManager,
		logger:            logger,
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

	// Extract model from request_params with default fallback from config
	model := s.config.DefaultModel
	if model == "" {
		model = "claude-haiku-4-5-20251001" // Fallback if config not set
	}
	if modelParam, ok := requestParams["model"].(string); ok && modelParam != "" {
		model = modelParam
	}

	// Validate and parse request params
	if err := llmModels.ValidateRequestParams(requestParams); err != nil {
		s.logger.Error("invalid request params", "error", err)
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	params, err := llmModels.GetRequestParamStruct(requestParams)
	if err != nil {
		s.logger.Error("failed to parse request params", "error", err)
		return nil, fmt.Errorf("failed to parse request params: %w", err)
	}

	// Allow model override via params
	if params.Model != nil && *params.Model != "" {
		model = *params.Model
	}

	// Create user turn + blocks and assistant turn atomically in a transaction
	var turn *llmModels.Turn
	var assistantTurn *llmModels.Turn
	now := time.Now()

	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// Create user turn
		turn = &llmModels.Turn{
			ChatID:       req.ChatID,
			PrevTurnID:   req.PrevTurnID,
			Role:         req.Role,
			SystemPrompt: req.SystemPrompt,
			Status:       "complete", // User turn is immediately complete
			CreatedAt:    now,
		}

		if err := s.turnRepo.CreateTurn(txCtx, turn); err != nil {
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

			if err := s.turnRepo.CreateTurnBlocks(txCtx, blocks); err != nil {
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

		if err := s.turnRepo.CreateTurn(txCtx, assistantTurn); err != nil {
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
	)

	// Get provider for model (do this synchronously to avoid race)
	provider, err := s.responseGenerator.registry.GetProvider(model)
	if err != nil {
		s.logger.Error("failed to get provider for streaming",
			"error", err,
			"model", model,
			"assistant_turn_id", assistantTurn.ID,
		)
		// Update turn to error status
		if updateErr := s.turnRepo.UpdateTurnError(ctx, assistantTurn.ID, fmt.Sprintf("failed to get provider: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return nil, fmt.Errorf("failed to get provider for model %s: %w", model, err)
	}

	// Create TurnExecutor immediately (before goroutine) to avoid race condition
	// This ensures SSE clients can connect while we're preparing the request
	executor := NewTurnExecutor(
		ctx,
		assistantTurn.ID,
		model,
		s.turnRepo,
		provider,
	)

	// Register executor in global registry IMMEDIATELY
	// This must happen before returning response to prevent race with SSE connections
	if !s.registry.Register(assistantTurn.ID, executor) {
		s.logger.Error("failed to register executor (already exists)",
			"assistant_turn_id", assistantTurn.ID,
		)
		return nil, fmt.Errorf("failed to register executor: already exists for turn %s", assistantTurn.ID)
	}

	s.logger.Info("executor registered, starting background streaming",
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
func (s *Service) startStreamingExecution(ctx context.Context, assistantTurnID, userTurnID string, executor *TurnExecutor, params *llmModels.RequestParams) {
	s.logger.Info("preparing streaming request",
		"assistant_turn_id", assistantTurnID,
	)

	// Get conversation history (turn path)
	path, err := s.turnRepo.GetTurnPath(ctx, userTurnID)
	if err != nil {
		s.logger.Error("failed to get turn path for streaming",
			"error", err,
			"user_turn_id", userTurnID,
		)
		if updateErr := s.turnRepo.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to get turn path: %v", err)); updateErr != nil {
			s.logger.Error("failed to update turn error", "error", updateErr)
		}
		return
	}

	// Load content blocks for all turns in the path
	for i := range path {
		blocks, err := s.turnRepo.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			s.logger.Error("failed to get content blocks",
				"error", err,
				"turn_id", path[i].ID,
			)
			if updateErr := s.turnRepo.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to get content blocks: %v", err)); updateErr != nil {
				s.logger.Error("failed to update turn error", "error", updateErr)
			}
			return
		}
		path[i].Blocks = blocks
	}

	// Build messages from turn history
	messages, err := s.buildMessagesFromPath(path)
	if err != nil {
		s.logger.Error("failed to build messages for streaming",
			"error", err,
		)
		if updateErr := s.turnRepo.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to build messages: %v", err)); updateErr != nil {
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

	// Note: Executor will:
	// - Stream from provider
	// - Accumulate deltas into TurnBlocks
	// - Broadcast SSE events to clients
	// - Update turn status on completion/error
	// - Registry will clean up executor after retention period
}

// buildMessagesFromPath converts turn history to LLM messages.
// path is ordered from oldest to newest (root → current turn)
func (s *Service) buildMessagesFromPath(path []llmModels.Turn) ([]llmSvc.Message, error) {
	messages := make([]llmSvc.Message, 0, len(path))

	for _, turn := range path {
		// Determine role
		var role string
		switch turn.Role {
		case "user":
			role = "user"
		case "assistant":
			role = "assistant"
		default:
			return nil, fmt.Errorf("unsupported turn role: %s", turn.Role)
		}

		// Get content blocks for this turn
		if len(turn.Blocks) == 0 {
			// Empty turn - skip it
			s.logger.Warn("skipping turn with no content blocks", "turn_id", turn.ID)
			continue
		}

		// Convert []TurnBlock to []*TurnBlock
		contentPtrs := make([]*llmModels.TurnBlock, len(turn.Blocks))
		for i := range turn.Blocks {
			contentPtrs[i] = &turn.Blocks[i]
		}

		messages = append(messages, llmSvc.Message{
			Role:    role,
			Content: contentPtrs,
		})
	}

	return messages, nil
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
		_, err := s.turnRepo.GetTurn(ctx, *prevTurnID)
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

	if err := s.turnRepo.CreateTurn(ctx, turn); err != nil {
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

		if err := s.turnRepo.CreateTurnBlocks(ctx, blocks); err != nil {
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
