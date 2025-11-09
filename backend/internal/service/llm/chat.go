package llm

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"meridian/internal/config"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
)

// chatService implements the ChatService interface
type chatService struct {
	chatRepo    llmRepo.ChatRepository
	turnRepo    llmRepo.TurnRepository
	projectRepo docsysRepo.ProjectRepository
	validator   *ChatValidator
	logger      *slog.Logger
}

// NewChatService creates a new chat service
func NewChatService(
	chatRepo llmRepo.ChatRepository,
	turnRepo llmRepo.TurnRepository,
	projectRepo docsysRepo.ProjectRepository,
	validator *ChatValidator,
	logger *slog.Logger,
) llmSvc.ChatService {
	return &chatService{
		chatRepo:    chatRepo,
		turnRepo:    turnRepo,
		projectRepo: projectRepo,
		validator:   validator,
		logger:      logger,
	}
}

// CreateChat creates a new chat session
func (s *chatService) CreateChat(ctx context.Context, req *llmSvc.CreateChatRequest) (*llmModels.Chat, error) {
	// Validate request
	if err := s.validateCreateChatRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Verify project exists and user has access
	_, err := s.projectRepo.GetByID(ctx, req.ProjectID, req.UserID)
	if err != nil {
		return nil, err
	}

	// Trim and normalize title
	title := strings.TrimSpace(req.Title)

	// Create chat
	chat := &llmModels.Chat{
		ProjectID: req.ProjectID,
		UserID:    req.UserID,
		Title:     title,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.chatRepo.CreateChat(ctx, chat); err != nil {
		return nil, err
	}

	s.logger.Info("chat created",
		"id", chat.ID,
		"title", chat.Title,
		"project_id", req.ProjectID,
		"user_id", req.UserID,
	)

	return chat, nil
}

// GetChat retrieves a chat by ID
func (s *chatService) GetChat(ctx context.Context, chatID, userID string) (*llmModels.Chat, error) {
	chat, err := s.chatRepo.GetChat(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}

	return chat, nil
}

// ListChats retrieves all chats for a project
func (s *chatService) ListChats(ctx context.Context, projectID, userID string) ([]llmModels.Chat, error) {
	// Verify project exists and user has access
	_, err := s.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}

	chats, err := s.chatRepo.ListChatsByProject(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}

	return chats, nil
}

// UpdateChat updates a chat's title
func (s *chatService) UpdateChat(ctx context.Context, chatID, userID string, req *llmSvc.UpdateChatRequest) (*llmModels.Chat, error) {
	// Validate request
	if err := s.validateUpdateChatRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Get existing chat
	chat, err := s.chatRepo.GetChat(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}

	// Trim and normalize title
	title := strings.TrimSpace(req.Title)

	// Update chat
	chat.Title = title
	chat.UpdatedAt = time.Now()

	if err := s.chatRepo.UpdateChat(ctx, chat); err != nil {
		return nil, err
	}

	s.logger.Info("chat updated",
		"id", chat.ID,
		"title", chat.Title,
		"user_id", userID,
	)

	return chat, nil
}

// DeleteChat soft-deletes a chat
func (s *chatService) DeleteChat(ctx context.Context, chatID, userID string) error {
	if err := s.chatRepo.DeleteChat(ctx, chatID, userID); err != nil {
		return err
	}

	s.logger.Info("chat deleted",
		"id", chatID,
		"user_id", userID,
	)

	return nil
}

// CreateTurn creates a new user turn (message from client)
// Note: This endpoint only creates user turns. LLM response generation
// will be triggered separately in Phase 2 (LLM integration).
// For now, assistant turns must be created manually via test tools.
func (s *chatService) CreateTurn(ctx context.Context, req *llmSvc.CreateTurnRequest) (*llmModels.Turn, error) {
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

	// Create turn
	now := time.Now()
	turn := &llmModels.Turn{
		ChatID:       req.ChatID,
		PrevTurnID:   req.PrevTurnID,
		Role:         req.Role,
		SystemPrompt: req.SystemPrompt,
		Status:       "pending",
		CreatedAt:    now,
	}

	if err := s.turnRepo.CreateTurn(ctx, turn); err != nil {
		return nil, err
	}

	// Create content blocks if provided
	if len(req.ContentBlocks) > 0 {
		blocks := make([]llmModels.ContentBlock, len(req.ContentBlocks))
		for i, blockInput := range req.ContentBlocks {
			blocks[i] = llmModels.ContentBlock{
				TurnID:      turn.ID,
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content, // nil becomes NULL in database
				CreatedAt:   now,
			}
		}

		if err := s.turnRepo.CreateContentBlocks(ctx, blocks); err != nil {
			return nil, err
		}

		// Attach content blocks to turn
		turn.ContentBlocks = blocks
	}

	s.logger.Info("turn created",
		"id", turn.ID,
		"chat_id", req.ChatID,
		"role", req.Role,
		"prev_turn_id", req.PrevTurnID,
		"content_blocks", len(req.ContentBlocks),
	)

	return turn, nil
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
//   turn, err := s.CreateAssistantTurnDebug(ctx, chatID, userTurnID, blocks, "claude-3-5-sonnet-20241022")
//
// The ResponseGenerator should:
// 1. Call this to create assistant turn with status="streaming"
// 2. Stream response chunks and append content blocks incrementally
// 3. Update turn status to "complete" when done
func (s *chatService) CreateAssistantTurnDebug(
	ctx context.Context,
	chatID string,
	userID string,
	prevTurnID *string,
	contentBlocks []llmSvc.ContentBlockInput,
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
		blocks := make([]llmModels.ContentBlock, len(contentBlocks))
		for i, blockInput := range contentBlocks {
			blocks[i] = llmModels.ContentBlock{
				TurnID:      turn.ID,
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content,
				CreatedAt:   now,
			}
		}

		if err := s.turnRepo.CreateContentBlocks(ctx, blocks); err != nil {
			return nil, err
		}

		turn.ContentBlocks = blocks
	}

	s.logger.Info("assistant turn created (internal)",
		"id", turn.ID,
		"chat_id", chatID,
		"prev_turn_id", prevTurnID,
		"model", model,
		"content_blocks", len(contentBlocks),
	)

	return turn, nil
}

// GetTurnPath retrieves the conversation path from a turn to root
func (s *chatService) GetTurnPath(ctx context.Context, turnID string) ([]llmModels.Turn, error) {
	turns, err := s.turnRepo.GetTurnPath(ctx, turnID)
	if err != nil {
		return nil, err
	}

	// Load content blocks for all turns (user and assistant)
	for i := range turns {
		blocks, err := s.turnRepo.GetContentBlocks(ctx, turns[i].ID)
		if err != nil {
			return nil, err
		}
		turns[i].ContentBlocks = blocks
	}

	return turns, nil
}

// GetTurnChildren retrieves all branches from a previous turn
func (s *chatService) GetTurnChildren(ctx context.Context, prevTurnID string) ([]llmModels.Turn, error) {
	turns, err := s.turnRepo.GetTurnChildren(ctx, prevTurnID)
	if err != nil {
		return nil, err
	}

	return turns, nil
}

// Validation methods

func (s *chatService) validateCreateChatRequest(req *llmSvc.CreateChatRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.UserID, validation.Required),
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxChatTitleLength),
		),
	)
}

func (s *chatService) validateUpdateChatRequest(req *llmSvc.UpdateChatRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxChatTitleLength),
		),
	)
}

func (s *chatService) validateCreateTurnRequest(req *llmSvc.CreateTurnRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ChatID, validation.Required),
		validation.Field(&req.Role,
			validation.Required,
			validation.In("user"), // Only allow user role from client (assistant turns created internally)
		),
		validation.Field(&req.ContentBlocks, validation.Each(validation.By(s.validateContentBlock))),
	)
}

func (s *chatService) validateContentBlock(value interface{}) error {
	block, ok := value.(llmSvc.ContentBlockInput)
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
