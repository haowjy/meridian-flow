package thread

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"

	"meridian/internal/config"
	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// Service implements the ThreadService interface
// Handles only thread session management (CRUD operations)
type Service struct {
	threadRepo  domainllm.ThreadStore
	projectRepo domaindocsys.ProjectStore
	logger      *slog.Logger
}

// NewService creates a new thread CRUD service
func NewService(
	threadRepo domainllm.ThreadStore,
	projectRepo domaindocsys.ProjectStore,
	logger *slog.Logger,
) domainllm.ThreadService {
	return &Service{
		threadRepo:  threadRepo,
		projectRepo: projectRepo,
		logger:      logger,
	}
}

// CreateThread creates a new thread session
func (s *Service) CreateThread(ctx context.Context, req *domainllm.CreateThreadRequest) (*domainllm.Thread, error) {
	// Validate request
	if err := s.validateCreateThreadRequest(req); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	// Verify project exists and user has access
	_, err := s.projectRepo.GetByID(ctx, req.ProjectID, req.UserID)
	if err != nil {
		return nil, err
	}

	// Trim and normalize title
	title := strings.TrimSpace(req.Title)

	// Create thread
	thread := &domainllm.Thread{
		ProjectID: req.ProjectID,
		UserID:    req.UserID,
		Title:     title,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.threadRepo.CreateThread(ctx, thread); err != nil {
		return nil, err
	}

	// Touch project activity (non-fatal)
	if err := s.projectRepo.TouchLastActivityAt(ctx, req.ProjectID); err != nil {
		s.logger.Warn("failed to touch project activity",
			"project_id", req.ProjectID,
			"error", err,
		)
	}

	s.logger.Info("thread created",
		"id", thread.ID,
		"title", thread.Title,
		"project_id", req.ProjectID,
		"user_id", req.UserID,
	)

	return thread, nil
}

// GetThread retrieves a thread by ID
func (s *Service) GetThread(ctx context.Context, threadID, userID string) (*domainllm.Thread, error) {
	thread, err := s.threadRepo.GetThread(ctx, threadID, userID)
	if err != nil {
		return nil, err
	}

	return thread, nil
}

// ListThreads retrieves all threads for a project
func (s *Service) ListThreads(ctx context.Context, projectID, userID string) ([]domainllm.Thread, error) {
	// Verify project exists and user has access
	_, err := s.projectRepo.GetByID(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}

	threads, err := s.threadRepo.ListThreadsByProject(ctx, projectID, userID)
	if err != nil {
		return nil, err
	}

	return threads, nil
}

// UpdateThread updates a thread's title
func (s *Service) UpdateThread(ctx context.Context, threadID, userID string, req *domainllm.UpdateThreadRequest) (*domainllm.Thread, error) {
	// Validate request
	if err := s.validateUpdateThreadRequest(req); err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("validation failed: %v", err))
	}

	// Get existing thread
	thread, err := s.threadRepo.GetThread(ctx, threadID, userID)
	if err != nil {
		return nil, err
	}

	// Trim and normalize title
	title := strings.TrimSpace(req.Title)

	// Update thread
	thread.Title = title
	thread.UpdatedAt = time.Now()

	if err := s.threadRepo.UpdateThread(ctx, thread); err != nil {
		return nil, err
	}

	s.logger.Debug("thread updated",
		"id", thread.ID,
		"title", thread.Title,
		"user_id", userID,
	)

	return thread, nil
}

// UpdateLastViewedTurn updates the last_viewed_turn_id field for a thread
func (s *Service) UpdateLastViewedTurn(ctx context.Context, threadID, userID, turnID string) error {
	// Validate input
	if threadID == "" {
		return domain.NewValidationErrorWithField("thread ID is required", "thread_id")
	}
	if userID == "" {
		return domain.NewValidationErrorWithField("user ID is required", "user_id")
	}
	if turnID == "" {
		return domain.NewValidationErrorWithField("turn ID is required", "turn_id")
	}

	// Update the last_viewed_turn_id
	// Repository validates thread ownership and turn belongs to thread
	if err := s.threadRepo.UpdateLastViewedTurn(ctx, threadID, userID, turnID); err != nil {
		return err
	}

	s.logger.Debug("last_viewed_turn_id updated",
		"thread_id", threadID,
		"turn_id", turnID,
		"user_id", userID,
	)

	return nil
}

// DeleteThread soft-deletes a thread
func (s *Service) DeleteThread(ctx context.Context, threadID, userID string) (*domainllm.Thread, error) {
	deletedThread, err := s.threadRepo.DeleteThread(ctx, threadID, userID)
	if err != nil {
		return nil, err
	}

	// Touch project activity (non-fatal)
	if err := s.projectRepo.TouchLastActivityAt(ctx, deletedThread.ProjectID); err != nil {
		s.logger.Warn("failed to touch project activity",
			"project_id", deletedThread.ProjectID,
			"error", err,
		)
	}

	s.logger.Info("thread deleted",
		"id", threadID,
		"user_id", userID,
	)

	return deletedThread, nil
}

// Validation methods

func (s *Service) validateCreateThreadRequest(req *domainllm.CreateThreadRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.UserID, validation.Required),
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxThreadTitleLength),
		),
	)
}

func (s *Service) validateUpdateThreadRequest(req *domainllm.UpdateThreadRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.Title,
			validation.Required,
			validation.Length(1, config.MaxThreadTitleLength),
		),
	)
}
