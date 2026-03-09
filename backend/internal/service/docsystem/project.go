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
	"meridian/internal/service/identifier"

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

	// Generate unique slug from name
	baseSlug := identifier.GenerateSlug(name)
	slug := identifier.EnsureUniqueSlug(baseSlug, func(testSlug string) bool {
		exists, _ := s.projectRepo.SlugExists(ctx, testSlug, req.UserID, nil)
		return exists
	})

	// Create project
	project := &models.Project{
		UserID:    req.UserID,
		Name:      name,
		Slug:      slug,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.projectRepo.Create(ctx, project); err != nil {
		return nil, err
	}

	s.logger.Info("project created",
		"id", project.ID,
		"name", project.Name,
		"slug", project.Slug,
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

// UpdateProject updates a project's fields (name, system_prompt, auto_accept_proposals).
// Only provided fields are updated - nil fields are left unchanged.
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

	// Update name if provided
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		// Regenerate slug if name changed (mutable slugs)
		if name != project.Name {
			baseSlug := identifier.GenerateSlug(name)
			project.Slug = identifier.EnsureUniqueSlug(baseSlug, func(testSlug string) bool {
				exists, _ := s.projectRepo.SlugExists(ctx, testSlug, userID, &project.ID)
				return exists
			})
		}
		project.Name = name
	}

	// Update system_prompt if present (tri-state: absent=don't change, null=clear, value=set)
	if req.SystemPrompt.Present {
		if req.SystemPrompt.Value == nil {
			// null = clear the prompt
			project.SystemPrompt = nil
		} else {
			// value = set to trimmed value (empty string after trimming clears it)
			trimmed := strings.TrimSpace(*req.SystemPrompt.Value)
			if trimmed == "" {
				project.SystemPrompt = nil
			} else {
				project.SystemPrompt = &trimmed
			}
		}
	}

	// Update auto_accept_proposals if present (tri-state: absent=don't change, null=clear, value=set)
	if req.AutoAcceptProposals.Present {
		if req.AutoAcceptProposals.Value == nil {
			project.AutoAcceptProposals = nil
		} else {
			autoAccept := *req.AutoAcceptProposals.Value
			project.AutoAcceptProposals = &autoAccept
		}
	}

	// Update preferences if provided (replaces entire preferences object)
	if req.Preferences != nil {
		project.Preferences = req.Preferences
	}

	project.UpdatedAt = time.Now()

	if err := s.projectRepo.Update(ctx, project); err != nil {
		return nil, err
	}

	s.logger.Debug("project updated",
		"id", project.ID,
		"name", project.Name,
		"slug", project.Slug,
		"has_system_prompt", project.SystemPrompt != nil,
		"has_auto_accept_override", project.AutoAcceptProposals != nil,
		"user_id", userID,
	)

	return project, nil
}

// DeleteProject soft-deletes a project by setting deleted_at timestamp
// Returns the deleted project with deleted_at set
// TODO: Implement background cleanup job to permanently delete soft-deleted items
//   - Suggested retention period: 30 days after soft delete
//   - Should cleanup projects, folders, documents, and threads
//   - Can be implemented as a cron job or background worker
//   - Consider adding a "restore" API endpoint before implementing hard delete
func (s *projectService) DeleteProject(ctx context.Context, id, userID string) (*models.Project, error) {
	// Verify project exists first (provides better error message)
	_, err := s.projectRepo.GetByID(ctx, id, userID)
	if err != nil {
		return nil, err
	}

	// Attempt soft delete
	project, err := s.projectRepo.Delete(ctx, id, userID)
	if err != nil {
		return nil, err
	}

	s.logger.Info("project soft-deleted",
		"id", id,
		"user_id", userID,
	)

	return project, nil
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
	// Name is optional but if provided, must be valid
	if req.Name != nil {
		if err := validation.Validate(*req.Name,
			validation.Required,
			validation.Length(1, config.MaxProjectNameLength),
			validation.By(s.validateProjectName),
		); err != nil {
			return err
		}
	}
	// system_prompt has no validation - any string is valid (nil clears it)
	return nil
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
