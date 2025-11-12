package chat

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

// Service implements the ChatService interface
// Handles only chat session management (CRUD operations)
type Service struct {
	chatRepo    llmRepo.ChatRepository
	projectRepo docsysRepo.ProjectRepository
	logger      *slog.Logger
}

// NewService creates a new chat CRUD service
func NewService(
	chatRepo llmRepo.ChatRepository,
	projectRepo docsysRepo.ProjectRepository,
	logger *slog.Logger,
) llmSvc.ChatService {
	return &Service{
		chatRepo:    chatRepo,
		projectRepo: projectRepo,
		logger:      logger,
	}
}

// CreateChat creates a new chat session
func (s *Service) CreateChat(ctx context.Context, req *llmSvc.CreateChatRequest) (*llmModels.Chat, error) {
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
func (s *Service) GetChat(ctx context.Context, chatID, userID string) (*llmModels.Chat, error) {
	chat, err := s.chatRepo.GetChat(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}

	return chat, nil
}

// ListChats retrieves all chats for a project
func (s *Service) ListChats(ctx context.Context, projectID, userID string) ([]llmModels.Chat, error) {
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
func (s *Service) UpdateChat(ctx context.Context, chatID, userID string, req *llmSvc.UpdateChatRequest) (*llmModels.Chat, error) {
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
func (s *Service) DeleteChat(ctx context.Context, chatID, userID string) (*llmModels.Chat, error) {
	deletedChat, err := s.chatRepo.DeleteChat(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}

	s.logger.Info("chat deleted",
		"id", chatID,
		"user_id", userID,
	)

	return deletedChat, nil
}

// Validation methods

func (s *Service) validateCreateChatRequest(req *llmSvc.CreateChatRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.UserID, validation.Required),
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxChatTitleLength),
		),
	)
}

func (s *Service) validateUpdateChatRequest(req *llmSvc.UpdateChatRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxChatTitleLength),
		),
	)
}
