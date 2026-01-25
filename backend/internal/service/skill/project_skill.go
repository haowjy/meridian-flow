package skill

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"meridian/internal/domain"
	docsysModels "meridian/internal/domain/models/docsystem"
	models "meridian/internal/domain/models/skill"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	"meridian/internal/domain/repositories"
	skillRepo "meridian/internal/domain/repositories/skill"
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
	skillSvc "meridian/internal/domain/services/skill"
	"meridian/internal/service/identifier"
)

// projectSkillService implements the ProjectSkillService interface
type projectSkillService struct {
	skillRepo    skillRepo.ProjectSkillRepository
	folderRepo   docsysRepo.FolderRepository
	documentRepo docsysRepo.DocumentRepository
	namespaceSvc docsysSvc.NamespaceService
	authorizer   services.ResourceAuthorizer
	txManager    repositories.TransactionManager
	logger       *slog.Logger
}

// NewProjectSkillService creates a new project skill service
func NewProjectSkillService(
	skillRepo skillRepo.ProjectSkillRepository,
	folderRepo docsysRepo.FolderRepository,
	documentRepo docsysRepo.DocumentRepository,
	namespaceSvc docsysSvc.NamespaceService,
	authorizer services.ResourceAuthorizer,
	txManager repositories.TransactionManager,
	logger *slog.Logger,
) skillSvc.ProjectSkillService {
	return &projectSkillService{
		skillRepo:    skillRepo,
		folderRepo:   folderRepo,
		documentRepo: documentRepo,
		namespaceSvc: namespaceSvc,
		authorizer:   authorizer,
		txManager:    txManager,
		logger:       logger,
	}
}

// skillMDPath returns the standard path to a skill's SKILL.md file
func skillMDPath(name string) string {
	return fmt.Sprintf(".meridian/skills/%s/SKILL.md", name)
}

// validateSkillName validates the skill name format
func validateSkillName(name string) error {
	// Skill names should be URL-safe identifiers
	// Allowed: lowercase letters, numbers, hyphens
	matched, _ := regexp.MatchString(`^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$`, name)
	if !matched {
		return fmt.Errorf("invalid skill name: must be lowercase alphanumeric with hyphens, e.g., 'writing-coach'")
	}
	if len(name) < 1 || len(name) > 50 {
		return fmt.Errorf("skill name must be between 1 and 50 characters")
	}
	return nil
}

// CreateSkill creates a new skill with its folder structure and SKILL.md
func (s *projectSkillService) CreateSkill(ctx context.Context, userID string, req skillSvc.CreateSkillRequest) (*models.ProjectSkill, error) {
	// Validate skill name
	if err := validateSkillName(req.Name); err != nil {
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

	var skill *models.ProjectSkill

	// Use transaction for atomicity
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// 1. Ensure /.meridian/skills/ exists
		skillsFolder, err := s.namespaceSvc.EnsureMeridianSubfolder(txCtx, req.ProjectID, "skills")
		if err != nil {
			return err // Pass through HTTPError directly
		}

		// 2. Create skill folder (/.meridian/skills/<name>/)
		now := time.Now()
		skillFolder, err := s.folderRepo.CreateHiddenIfNotExists(txCtx, req.ProjectID, &skillsFolder.ID, req.Name)
		if err != nil {
			return err // Pass through HTTPError directly
		}

		// 3. Create SKILL.md document (content only, no frontmatter - metadata is in DB)
		content := generateSkillContent(req)
		doc, err := s.createSkillDocument(txCtx, req.ProjectID, skillFolder.ID, content, now)
		if err != nil {
			return err // Pass through HTTPError directly
		}

		s.logger.Debug("created SKILL.md document",
			"project_id", req.ProjectID,
			"document_id", doc.ID,
			"skill_name", req.Name,
		)

		// 4. Create DB record with metadata
		skill = &models.ProjectSkill{
			ProjectID:        req.ProjectID,
			InstanceFolderID: skillFolder.ID,
			Name:             req.Name,
			DisplayName:      req.DisplayName,
			Description:      req.Description,
			Position:         nextPosition,
			SyncState:        models.SyncStateDetached,
			IsDirty:          false,
			CreatedAt:        now,
			UpdatedAt:        now,
		}

		// Store metadata using typed setter
		skill.SetMetadata(models.SkillMetadata{
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

// generateSkillContent generates the SKILL.md content (body only, no frontmatter)
// Metadata is stored in the DB's JSONB column, not in the file
func generateSkillContent(req skillSvc.CreateSkillRequest) string {
	// Content (if provided) or default template
	if req.Content != "" {
		return req.Content
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# %s\n\n", req.DisplayName))
	sb.WriteString("<!-- Add your skill instructions here -->\n")
	return sb.String()
}

// createSkillDocument creates the SKILL.md document in the skill folder
func (s *projectSkillService) createSkillDocument(ctx context.Context, projectID, folderID, content string, now time.Time) (*docsysModels.Document, error) {
	// Create the SKILL.md document directly via repository
	// This is acceptable within a transaction context
	doc := &docsysModels.Document{
		ProjectID: projectID,
		FolderID:  &folderID,
		Name:      "SKILL",
		Extension: ".md",
		Content:   content,
		Metadata:  docsysModels.DocumentMetadata{}, // Satisfies NOT NULL constraint
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Generate proper slug using identifier package (consistent with document service)
	doc.Slug = identifier.GenerateSlug("SKILL")

	if err := s.documentRepo.Create(ctx, doc); err != nil {
		return nil, err
	}

	return doc, nil
}

// ListSkills lists all skills for a project (metadata only)
func (s *projectSkillService) ListSkills(ctx context.Context, userID, projectID string) ([]*models.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	return s.skillRepo.ListByProject(ctx, projectID)
}

// GetSkill retrieves a skill by ID with content
func (s *projectSkillService) GetSkill(ctx context.Context, userID, projectID, skillID string) (*models.ProjectSkillWithContent, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	skill, err := s.skillRepo.GetByID(ctx, skillID, projectID)
	if err != nil {
		return nil, err
	}

	// Load content from SKILL.md
	content, err := s.loadContent(ctx, skill)
	if err != nil {
		s.logger.Warn("failed to load skill content",
			"skill_id", skillID,
			"error", err,
		)
		content = "" // Continue without content
	}

	return &models.ProjectSkillWithContent{
		ProjectSkill: *skill,
		Content:      content,
	}, nil
}

// GetSkillByName retrieves a skill by name with content
func (s *projectSkillService) GetSkillByName(ctx context.Context, userID, projectID, name string) (*models.ProjectSkillWithContent, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	skill, err := s.skillRepo.GetByName(ctx, name, projectID)
	if err != nil {
		return nil, err
	}

	// Load content from SKILL.md
	content, err := s.loadContent(ctx, skill)
	if err != nil {
		s.logger.Warn("failed to load skill content",
			"skill_name", name,
			"error", err,
		)
		content = ""
	}

	return &models.ProjectSkillWithContent{
		ProjectSkill: *skill,
		Content:      content,
	}, nil
}

// loadContent loads the SKILL.md content for a skill
func (s *projectSkillService) loadContent(ctx context.Context, skill *models.ProjectSkill) (string, error) {
	path := skillMDPath(skill.Name)
	doc, err := s.documentRepo.GetByPath(ctx, path, skill.ProjectID)
	if err != nil {
		return "", err
	}

	return doc.Content, nil
}

// UpdateSkill updates a skill's metadata and/or content
func (s *projectSkillService) UpdateSkill(ctx context.Context, userID, projectID, skillID string, req skillSvc.UpdateSkillRequest) (*models.ProjectSkill, error) {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	skill, err := s.skillRepo.GetByID(ctx, skillID, projectID)
	if err != nil {
		return nil, err
	}

	// Update basic fields if provided
	if req.DisplayName != nil {
		skill.DisplayName = *req.DisplayName
	}
	if req.Description != nil {
		skill.Description = *req.Description
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

	// Mark dirty when content changes (before update, so single write)
	if req.Content != nil {
		skill.IsDirty = true
		skill.SyncState = models.SyncStateModified
	}

	// Use transaction for atomicity of skill + document updates
	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// Update skill record
		if err := s.skillRepo.Update(txCtx, skill); err != nil {
			return err
		}

		// Update SKILL.md content if provided
		if req.Content != nil {
			path := skillMDPath(skill.Name)
			doc, err := s.documentRepo.GetByPath(txCtx, path, skill.ProjectID)
			if err != nil {
				return err
			}
			doc.Content = *req.Content
			if err := s.documentRepo.Update(txCtx, doc); err != nil {
				return err
			}
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

// ReorderSkills updates the positions of skills
func (s *projectSkillService) ReorderSkills(ctx context.Context, userID, projectID string, skillIDs []string) error {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return err
	}

	return s.skillRepo.UpdatePositions(ctx, projectID, skillIDs)
}

// DeleteSkill soft-deletes a skill and its associated folder/documents
func (s *projectSkillService) DeleteSkill(ctx context.Context, userID, projectID, skillID string) error {
	// Authorize
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return err
	}

	// Get skill to retrieve folder ID before deletion
	skill, err := s.skillRepo.GetByID(ctx, skillID, projectID)
	if err != nil {
		return err
	}

	// Use transaction to ensure atomicity of skill + folder deletion
	return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// 1. Soft-delete the skill record first
		if err := s.skillRepo.Delete(txCtx, skillID, projectID); err != nil {
			return err
		}

		// 2. Soft-delete all documents in the skill folder
		docs, err := s.documentRepo.ListByFolder(txCtx, &skill.InstanceFolderID, projectID)
		if err != nil {
			return err
		}

		for _, doc := range docs {
			if err := s.documentRepo.Delete(txCtx, doc.ID, projectID); err != nil {
				s.logger.Warn("failed to delete skill document",
					"skill_id", skillID,
					"document_id", doc.ID,
					"error", err,
				)
				// Continue deleting other documents
			}
		}

		// 3. Soft-delete the skill folder
		if err := s.folderRepo.Delete(txCtx, skill.InstanceFolderID, projectID); err != nil {
			return err
		}

		s.logger.Info("skill deleted with folder and documents",
			"skill_id", skillID,
			"project_id", projectID,
			"folder_id", skill.InstanceFolderID,
			"documents_deleted", len(docs),
		)

		return nil
	})
}

// LoadSkillContent loads the content of a skill's SKILL.md file
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

	content, err := s.loadContent(ctx, skill)
	if err != nil {
		return "", err
	}

	// Content no longer has frontmatter, return as-is
	return content, nil
}
