package skill

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"gopkg.in/yaml.v3"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	skilldomain "meridian/internal/domain/skill"
)

// projectSkillService implements the ProjectSkillService interface
type projectSkillService struct {
	skillRepo    skilldomain.ProjectSkillStore
	docStore     domaindocsys.DocumentStore // For writing SKILL.md files to .agents/skills/<slug>/
	folderRepo   domaindocsys.FolderStore
	namespaceSvc domaindocsys.NamespaceService
	authorizer   authdomain.ResourceAuthorizer
	txManager    domain.TransactionManager
	logger       *slog.Logger
}

// NewProjectSkillService creates a new project skill service.
// docStore is used to persist SKILL.md files in the .agents/skills/ document tree
// alongside the legacy DB records.
func NewProjectSkillService(
	skillRepo skilldomain.ProjectSkillStore,
	docStore domaindocsys.DocumentStore,
	folderRepo domaindocsys.FolderStore,
	namespaceSvc domaindocsys.NamespaceService,
	authorizer authdomain.ResourceAuthorizer,
	txManager domain.TransactionManager,
	logger *slog.Logger,
) skilldomain.ProjectSkillService {
	return &projectSkillService{
		skillRepo:    skillRepo,
		docStore:     docStore,
		folderRepo:   folderRepo,
		namespaceSvc: namespaceSvc,
		authorizer:   authorizer,
		txManager:    txManager,
		logger:       logger,
	}
}

// --- SKILL.md helpers --------------------------------------------------------

// skillMDFrontmatter is the struct for reading and writing SKILL.md YAML frontmatter.
// Hyphenated yaml tags match the SKILL.md spec (and the reader in skill_resolver.go).
// All fields the resolver reads must be present here so round-trips preserve them.
type skillMDFrontmatter struct {
	Name                   string  `yaml:"name"`
	Description            string  `yaml:"description,omitempty"`
	UserInvocable          *bool   `yaml:"user-invocable,omitempty"`
	DisableModelInvocation bool    `yaml:"disable-model-invocation,omitempty"`
	Position               *int    `yaml:"position,omitempty"`
	Version                *string `yaml:"version,omitempty"`
}

// buildSkillMDContent serialises a ProjectSkill to SKILL.md format.
// Format: "---\n<YAML frontmatter>---\n<skill body>".
// Only non-default values are emitted to keep SKILL.md files minimal.
func buildSkillMDContent(skill *skilldomain.ProjectSkill) (string, error) {
	meta := skill.GetMetadata()

	fm := skillMDFrontmatter{
		Name:        skill.Name,
		Description: skill.Description,
	}
	if !meta.UserInvocable {
		f := false
		fm.UserInvocable = &f
	}
	if meta.DisableModelInvocation {
		fm.DisableModelInvocation = true
	}
	if skill.Position > 0 {
		p := skill.Position
		fm.Position = &p
	}

	yamlBytes, err := yaml.Marshal(fm)
	if err != nil {
		return "", fmt.Errorf("marshal skill frontmatter: %w", err)
	}

	// yaml.Marshal appends a trailing newline so "---\n<yaml>---\n<body>" is correct.
	return "---\n" + string(yamlBytes) + "---\n" + skill.Content, nil
}

// ensureAgentsSkillFolder creates (or returns existing) .agents/skills/<slug>/ folder.
// The function is idempotent; it is safe to call inside or outside a transaction.
func (s *projectSkillService) ensureAgentsSkillFolder(ctx context.Context, projectID, slug string) (string, error) {
	agentsFolder, err := s.folderRepo.CreateSystemIfNotExists(ctx, projectID, ".agents", nil)
	if err != nil {
		return "", fmt.Errorf("ensure .agents folder: %w", err)
	}

	skillsFolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, projectID, &agentsFolder.ID, "skills")
	if err != nil {
		return "", fmt.Errorf("ensure .agents/skills folder: %w", err)
	}

	skillFolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, projectID, &skillsFolder.ID, slug)
	if err != nil {
		return "", fmt.Errorf("ensure .agents/skills/%s folder: %w", slug, err)
	}

	return skillFolder.ID, nil
}

// writeSkillFile upserts .agents/skills/<slug>/SKILL.md with the current skill state.
// Non-fatal: errors are returned so callers can decide whether to log-and-continue or
// propagate. Callers that treat files as optional should warn-and-continue.
func (s *projectSkillService) writeSkillFile(ctx context.Context, projectID string, skill *skilldomain.ProjectSkill) error {
	skillFolderID, err := s.ensureAgentsSkillFolder(ctx, projectID, skill.Name)
	if err != nil {
		return err
	}

	content, err := buildSkillMDContent(skill)
	if err != nil {
		return err
	}

	path := fmt.Sprintf(".agents/skills/%s/SKILL.md", skill.Name)

	existing, err := s.docStore.GetByPath(ctx, path, projectID)
	if err != nil {
		var notFound *domain.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("check existing SKILL.md: %w", err)
		}
		// File does not exist — create it.
		now := time.Now().UTC()
		doc := &domaindocsys.Document{
			ProjectID: projectID,
			FolderID:  &skillFolderID,
			Name:      "SKILL",
			Extension: ".md",
			Content:   content,
			CreatedAt: now,
			UpdatedAt: now,
		}
		return s.docStore.Create(ctx, doc)
	}

	// File exists — update content in place.
	existing.Content = content
	existing.UpdatedAt = time.Now().UTC()
	return s.docStore.Update(ctx, existing)
}

// deleteSkillFile soft-deletes .agents/skills/<slug>/SKILL.md and its parent
// folder .agents/skills/<slug>/. Both are removed so that SkillResolver.List
// does not encounter an orphaned folder and permanently report a ValidationIssue.
// Missing file or folder is treated as a no-op (idempotent delete).
func (s *projectSkillService) deleteSkillFile(ctx context.Context, projectID, slug string) error {
	path := fmt.Sprintf(".agents/skills/%s/SKILL.md", slug)
	doc, err := s.docStore.GetByPath(ctx, path, projectID)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			// SKILL.md already gone; still try to clean up the parent folder below.
		} else {
			return fmt.Errorf("find SKILL.md for deletion: %w", err)
		}
	} else {
		if err := s.docStore.Delete(ctx, doc.ID, projectID); err != nil {
			return fmt.Errorf("delete SKILL.md: %w", err)
		}
	}

	// Delete the parent folder (.agents/skills/<slug>/) so SkillResolver.List
	// never finds an orphaned directory after the skill is gone.
	folderPath := fmt.Sprintf(".agents/skills/%s", slug)
	folder, err := s.folderRepo.GetByPath(ctx, projectID, folderPath)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil // Folder already gone — nothing to do.
		}
		return fmt.Errorf("find skill folder for deletion: %w", err)
	}
	if err := s.folderRepo.Delete(ctx, folder.ID, projectID); err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil // Already deleted concurrently.
		}
		return fmt.Errorf("delete skill folder: %w", err)
	}
	return nil
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

		// 2. Create DB record with content
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

		// 3. Write SKILL.md to .agents/skills/<name>/ (file is the runtime read path).
		// Non-fatal: log a warning on failure rather than rolling back the DB insert.
		if writeErr := s.writeSkillFile(txCtx, req.ProjectID, skill); writeErr != nil {
			s.logger.Warn("failed to write SKILL.md on create; skill saved to DB only",
				"skill_name", req.Name,
				"project_id", req.ProjectID,
				"error", writeErr,
			)
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

	// Capture old name BEFORE any mutation for SKILL.md rename path.
	oldName := skill.Name

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

		// Sync SKILL.md — non-fatal, log a warning on failure.
		// On rename, delete old SKILL.md first so the old file is cleaned up.
		if nameChanged {
			if delErr := s.deleteSkillFile(txCtx, projectID, oldName); delErr != nil {
				s.logger.Warn("failed to delete old SKILL.md on rename; orphaned file may persist",
					"old_name", oldName,
					"project_id", projectID,
					"error", delErr,
				)
			}
		}
		if writeErr := s.writeSkillFile(txCtx, projectID, skill); writeErr != nil {
			s.logger.Warn("failed to write SKILL.md on update; skill saved to DB only",
				"skill_name", skill.Name,
				"project_id", projectID,
				"error", writeErr,
			)
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
		// 1. Soft-delete the skill record first (source of truth)
		if err := s.skillRepo.Delete(txCtx, skillID, projectID); err != nil {
			return err
		}

		// 2. Soft-delete the skill folder (content is in DB, folder is for references)
		// Handle missing folder gracefully - skill record is source of truth
		if err := s.folderRepo.Delete(txCtx, skill.InstanceFolderID, projectID); err != nil {
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

		// 3. Delete SKILL.md from .agents/skills/<name>/ — non-fatal.
		if delErr := s.deleteSkillFile(txCtx, projectID, skill.Name); delErr != nil {
			s.logger.Warn("failed to delete SKILL.md; orphaned file may persist",
				"skill_name", skill.Name,
				"project_id", projectID,
				"error", delErr,
			)
		}

		s.logger.Info("skill deleted",
			"skill_id", skillID,
			"project_id", projectID,
			"folder_id", skill.InstanceFolderID,
		)

		return nil
	})
}
