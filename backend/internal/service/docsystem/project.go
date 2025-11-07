package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"

	validation "github.com/go-ozzo/ozzo-validation/v4"
)

// projectService implements the ProjectService interface
type projectService struct {
	projectRepo docsysRepo.ProjectRepository
	logger      *slog.Logger
}

// NewProjectService creates a new project service
func NewProjectService(
	projectRepo docsysRepo.ProjectRepository,
	logger *slog.Logger,
) docsysSvc.ProjectService {
	return &projectService{
		projectRepo: projectRepo,
		logger:      logger,
	}
}

// CreateProject creates a new project
func (s *projectService) CreateProject(ctx context.Context, req *docsysSvc.CreateProjectRequest) (*models.Project, error) {
	// Validate request
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Trim and normalize name
	name := strings.TrimSpace(req.Name)

	// Create project
	project := &models.Project{
		UserID:    req.UserID,
		Name:      name,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.projectRepo.Create(ctx, project); err != nil {
		return nil, err
	}

	s.logger.Info("project created",
		"id", project.ID,
		"name", project.Name,
		"user_id", req.UserID,
	)

	return project, nil
}

// GetProject retrieves a project by ID
func (s *projectService) GetProject(ctx context.Context, id, userID string) (*models.Project, error) {
	project, err := s.projectRepo.GetByID(ctx, id, userID)
	if err != nil {
		return nil, err
	}

	return project, nil
}

// ListProjects retrieves all projects for a user
func (s *projectService) ListProjects(ctx context.Context, userID string) ([]models.Project, error) {
	projects, err := s.projectRepo.List(ctx, userID)
	if err != nil {
		return nil, err
	}

	return projects, nil
}

// UpdateProject updates a project's name
func (s *projectService) UpdateProject(ctx context.Context, id, userID string, req *docsysSvc.UpdateProjectRequest) (*models.Project, error) {
	// Validate request
	if err := s.validateUpdateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Get existing project
	project, err := s.projectRepo.GetByID(ctx, id, userID)
	if err != nil {
		return nil, err
	}

	// Trim and normalize name
	name := strings.TrimSpace(req.Name)

	// Update fields
	project.Name = name
	project.UpdatedAt = time.Now()

	if err := s.projectRepo.Update(ctx, project); err != nil {
		return nil, err
	}

	s.logger.Info("project updated",
		"id", project.ID,
		"name", project.Name,
		"user_id", userID,
	)

	return project, nil
}

// DeleteProject deletes a project
func (s *projectService) DeleteProject(ctx context.Context, id, userID string) error {
	// Verify project exists first (provides better error message)
	_, err := s.projectRepo.GetByID(ctx, id, userID)
	if err != nil {
		return err
	}

	// Attempt delete
	if err := s.projectRepo.Delete(ctx, id, userID); err != nil {
		return err
	}

	s.logger.Info("project deleted",
		"id", id,
		"user_id", userID,
	)

	return nil
}

// validateCreateRequest validates a create project request
func (s *projectService) validateCreateRequest(req *docsysSvc.CreateProjectRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.UserID, validation.Required),
		validation.Field(&req.Name,
			validation.Required,
			validation.Length(1, config.MaxProjectNameLength),
			validation.By(s.validateProjectName),
		),
	)
}

// validateUpdateRequest validates an update project request
func (s *projectService) validateUpdateRequest(req *docsysSvc.UpdateProjectRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.Name,
			validation.Required,
			validation.Length(1, config.MaxProjectNameLength),
			validation.By(s.validateProjectName),
		),
	)
}

// validateProjectName validates a project name
func (s *projectService) validateProjectName(value interface{}) error {
	name, ok := value.(string)
	if !ok {
		return fmt.Errorf("name must be a string")
	}

	// Trim for validation
	name = strings.TrimSpace(name)

	// Check if empty after trimming
	if name == "" {
		return fmt.Errorf("name cannot be empty")
	}

	return nil
}
