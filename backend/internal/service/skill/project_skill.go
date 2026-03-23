package skill

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	skilldomain "meridian/internal/domain/skill"
)

// projectSkillService implements the ProjectSkillService interface
type projectSkillService struct {
	skillRepo    skilldomain.ProjectSkillStore
	folderRepo   domaindocsys.FolderStore
	namespaceSvc domaindocsys.NamespaceService
	authorizer   authdomain.ResourceAuthorizer
	txManager    domain.TransactionManager
	logger       *slog.Logger
}

// NewProjectSkillService creates a new project skill service
func NewProjectSkillService(
	skillRepo skilldomain.ProjectSkillStore,
	folderRepo domaindocsys.FolderStore,
	namespaceSvc domaindocsys.NamespaceService,
	authorizer authdomain.ResourceAuthorizer,
	txManager domain.TransactionManager,
	logger *slog.Logger,
) skilldomain.ProjectSkillService {
	return &projectSkillService{
		skillRepo:    skillRepo,
		folderRepo:   folderRepo,
		namespaceSvc: namespaceSvc,
		authorizer:   authorizer,
		txManager:    txManager,
		logger:       logger,
	}
}

// validateSkillName validates the skill name format
func validateSkillName(name string) error {
	// Skill names should be URL-safe identifiers
	// Allowed: letters (mixed case), numbers, hyphens
	// Must start and end with alphanumeric (not hyphen)
	matched, _ := regexp.MatchString(`^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`, name)
	if !matched {
		return domain.NewValidationErrorWithField(
			"invalid skill name: must be alphanumeric with hyphens, cannot start or end with hyphen, e.g., 'WritingCoach' or 'my-skill'",
			"name")
	}
	if len(name) < 1 || len(name) > 50 {
		return domain.NewValidationErrorWithField(
			"skill name must be between 1 and 50 characters",
			"name")
	}
	return nil
}

// validateSkillDescription validates the skill description length
func validateSkillDescription(description string) error {
	if len(description) > config.MaxSkillDescriptionLength {
		return domain.NewValidationErrorWithField(
			fmt.Sprintf("description must be %d characters or less", config.MaxSkillDescriptionLength),
			"description")
	}
	return nil
}

// CreateSkill creates a new skill with its folder structure
// Content is stored in DB, folder exists for references/export
func (s *projectSkillService) CreateSkill(ctx context.Context, userID string, req skilldomain.CreateSkillRequest) (*skilldomain.ProjectSkill, error) {
	// Validate skill name
	if err := validateSkillName(req.Name); err != nil {
		return nil, err
	}

	// Validate skill description
	if err := validateSkillDescription(req.Description); err != nil {
		return nil, err
	}

	// Authorize: check user can access this project
	if err := s.authorizer.CanAccessProject(ctx, userID, req.ProjectID); err != nil {
		return nil, err
	}

	// Check if a skill with this name already exists (among active skills)
	// GetByName already filters out soft-deleted skills
	existingSkill, err := s.skillRepo.GetByName(ctx, req.Name, req.ProjectID)
	if err == nil && existingSkill != nil {
		// Skill with this name already exists and is not deleted
		return nil, &domain.ConflictError{
			Message:      fmt.Sprintf("a skill named %q already exists in this project", req.Name),
			ResourceType: "skill",
			ResourceID:   existingSkill.ID,
		}
	}
	// If error is ErrNotFound, that's expected - no conflict
	// Other errors will be caught by transaction

	// Count existing skills to set position (append to end)
	existingSkills, err := s.skillRepo.ListByProject(ctx, req.ProjectID)
	if err != nil {
		return nil, err
	}
	nextPosition := len(existingSkills)

	// Generate default content if not provided
	content := req.Content
	if content == "" {
		content = fmt.Sprintf("# %s\n\n<!-- Add your skill instructions here -->\n", req.Name)
	}

	var skill *skilldomain.ProjectSkill

	// Use transaction for atomicity
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// 1. Create skill folder (/.meridian/skills/<name>/) using shared helper
		// Folder exists for future reference documents and export functionality
		skillFolderID, err := s.ensureSkillFolder(txCtx, &skilldomain.ProjectSkill{
			ProjectID: req.ProjectID,
			Name:      req.Name,
		})
		if err != nil {
			return err
		}

		// 2. Create DB record with content (no SKILL.md document)
		now := time.Now().UTC()
		skill = &skilldomain.ProjectSkill{
			ProjectID:        req.ProjectID,
			InstanceFolderID: skillFolderID,
			Name:             req.Name,
			Description:      req.Description,
			Content:          content,
			Position:         nextPosition,
			Enabled:          true, // Skills are enabled by default
			SyncState:        skilldomain.SyncStateDetached,
			IsDirty:          false,
			CreatedAt:        now,
			UpdatedAt:        now,
		}

		// Store metadata using typed setter
		skill.SetMetadata(skilldomain.SkillMetadata{
			DisableModelInvocation: req.DisableModelInvocation,
			UserInvocable:          req.UserInvocable,
		})

		if err := s.skillRepo.Create(txCtx, skill); err != nil {
			return err // Pass through HTTPError directly
		}

		return nil
	})

	if err != nil {
		s.logger.Error("failed to create skill in transaction",
			"project_id", req.ProjectID,
			"skill_name", req.Name,
			"error", err,
		)
		return nil, err
	}

	s.logger.Info("skill created",
		"project_id", req.ProjectID,
		"skill_id", skill.ID,
		"skill_name", skill.Name,
	)

	return skill, nil
}

// ListSkills lists all skills for a project (metadata only)
func (s *projectSkillService) ListSkills(ctx context.Context, userID, projectID string) ([]*skilldomain.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	return s.skillRepo.ListByProject(ctx, projectID)
}

// GetSkill retrieves a skill by ID (content included in model)
func (s *projectSkillService) GetSkill(ctx context.Context, userID, projectID, skillID string) (*skilldomain.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	return s.skillRepo.GetByID(ctx, skillID, projectID)
}

// GetSkillByName retrieves a skill by name (content included in model)
func (s *projectSkillService) GetSkillByName(ctx context.Context, userID, projectID, name string) (*skilldomain.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	return s.skillRepo.GetByName(ctx, name, projectID)
}

// UpdateSkill updates a skill's metadata and/or content
func (s *projectSkillService) UpdateSkill(ctx context.Context, userID, projectID, skillID string, req skilldomain.UpdateSkillRequest) (*skilldomain.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	skill, err := s.skillRepo.GetByID(ctx, skillID, projectID)
	if err != nil {
		return nil, err
	}

	// Track name change BEFORE updating skill.Name (used later for folder rename)
	nameChanged := req.Name != nil && *req.Name != skill.Name

	// Update basic fields if provided
	if nameChanged {
		if err := validateSkillName(*req.Name); err != nil {
			return nil, err
		}

		// Enforce uniqueness per project (active skills only).
		existingSkill, err := s.skillRepo.GetByName(ctx, *req.Name, projectID)
		if err == nil && existingSkill != nil && existingSkill.ID != skill.ID {
			return nil, &domain.ConflictError{
				Message:      fmt.Sprintf("a skill named %q already exists in this project", *req.Name),
				ResourceType: "skill",
				ResourceID:   existingSkill.ID,
			}
		}

		skill.Name = *req.Name
	}
	if req.Description != nil {
		if err := validateSkillDescription(*req.Description); err != nil {
			return nil, err
		}
		skill.Description = *req.Description
	}
	if req.Content != nil {
		skill.Content = *req.Content
		skill.IsDirty = true
		skill.SyncState = skilldomain.SyncStateModified
	}
	if req.Enabled != nil {
		skill.Enabled = *req.Enabled
	}

	// Update metadata fields using getter/setter pattern
	meta := skill.GetMetadata()
	if req.DisableModelInvocation != nil {
		meta.DisableModelInvocation = *req.DisableModelInvocation
	}
	if req.UserInvocable != nil {
		meta.UserInvocable = *req.UserInvocable
	}
	skill.SetMetadata(meta)

	// Use transaction for atomicity of skill + folder updates
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// If the skill's name changed, rename the instance folder to keep the structure
		// consistent: /.meridian/skills/<name>/.
		// NOTE: Only attempt folder lookup/rename when name actually changed, not just when
		// name is provided. Frontend always sends name on every save.
		if nameChanged {
			folder, err := s.folderRepo.GetByID(txCtx, skill.InstanceFolderID, projectID)
			if err != nil {
				// Folder missing (corrupted/legacy data) - recreate it with the new name
				var notFoundErr *domain.NotFoundError
				if errors.As(err, &notFoundErr) {
					s.logger.Warn("skill folder missing, recreating",
						"skill_id", skill.ID,
						"skill_name", skill.Name,
						"missing_folder_id", skill.InstanceFolderID,
					)
					newFolderID, err := s.ensureSkillFolder(txCtx, skill)
					if err != nil {
						return err
					}
					skill.InstanceFolderID = newFolderID
				} else {
					return err
				}
			} else if folder.Name != skill.Name {
				// Folder exists - rename it
				folder.Name = skill.Name
				folder.UpdatedAt = time.Now().UTC()
				if err := s.folderRepo.Update(txCtx, folder); err != nil {
					return err
				}
			}
		}

		// Update skill record (content is stored in DB)
		if err := s.skillRepo.Update(txCtx, skill); err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		s.logger.Error("failed to update skill",
			"skill_id", skillID,
			"project_id", projectID,
			"error", err,
		)
		return nil, err
	}

	return skill, nil
}

// ensureSkillFolder ensures the skill's instance folder exists, creating it if missing.
// Returns the folder ID (may be new if recreated).
func (s *projectSkillService) ensureSkillFolder(ctx context.Context, skill *skilldomain.ProjectSkill) (string, error) {
	// 1. Ensure /.meridian/skills/ exists
	skillsFolder, err := s.namespaceSvc.EnsureMeridianSubfolder(ctx, skill.ProjectID, "skills")
	if err != nil {
		return "", err
	}

	// 2. Create skill folder (/.meridian/skills/<name>/)
	newFolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, skill.ProjectID, &skillsFolder.ID, skill.Name)
	if err != nil {
		return "", err
	}

	return newFolder.ID, nil
}

// ReorderSkills updates the positions of skills
func (s *projectSkillService) ReorderSkills(ctx context.Context, userID, projectID string, skillIDs []string) error {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return err
	}

	return s.skillRepo.UpdatePositions(ctx, projectID, skillIDs)
}

// DeleteSkill soft-deletes a skill and its associated folder
func (s *projectSkillService) DeleteSkill(ctx context.Context, userID, projectID, skillID string) (*skilldomain.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	// Get skill to retrieve folder ID before deletion
	skill, err := s.skillRepo.GetByID(ctx, skillID, projectID)
	if err != nil {
		return nil, err
	}

	var deletedSkill *skilldomain.ProjectSkill

	// Use transaction to ensure atomicity of skill + folder deletion
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// 1. Soft-delete the skill record first (source of truth)
		deletedSkill, err = s.skillRepo.Delete(txCtx, skillID, projectID)
		if err != nil {
			return err
		}

		// 2. Soft-delete the skill folder (content is in DB, folder is for references)
		// Handle missing folder gracefully - skill record is source of truth
		if _, err := s.folderRepo.Delete(txCtx, skill.InstanceFolderID, projectID); err != nil {
			var notFoundErr *domain.NotFoundError
			if !errors.As(err, &notFoundErr) {
				return err // Unexpected error - fail
			}
			// Folder missing (corrupted/legacy data) - log but continue
			s.logger.Warn("skill folder missing during deletion, proceeding",
				"skill_id", skillID,
				"folder_id", skill.InstanceFolderID,
			)
		}

		s.logger.Info("skill deleted",
			"skill_id", skillID,
			"project_id", projectID,
			"folder_id", skill.InstanceFolderID,
		)

		return nil
	})

	if err != nil {
		return nil, err
	}

	return deletedSkill, nil
}

// LoadSkillContent loads the content of a skill (from DB)
// This is used by the skill_invoke tool
func (s *projectSkillService) LoadSkillContent(ctx context.Context, userID, projectID, name string) (string, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return "", err
	}

	skill, err := s.skillRepo.GetByName(ctx, name, projectID)
	if err != nil {
		return "", err
	}

	return skill.Content, nil
}
