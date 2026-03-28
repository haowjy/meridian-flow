package skill

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	skilldomain "meridian/internal/domain/skill"
	"meridian/internal/pkg/frontmatter"

	"gopkg.in/yaml.v3"
)

// fileProjectSkillService implements ProjectSkillService using .agents/skills/<slug>/SKILL.md
// as source of truth.
type fileProjectSkillService struct {
	docStore      domaindocsys.DocumentStore
	folderRepo    domaindocsys.FolderStore
	namespaceSvc  domaindocsys.NamespaceService
	authorizer    authdomain.ResourceAuthorizer
	skillResolver domainagents.SkillResolver
	txManager     domain.TransactionManager
	logger        *slog.Logger
}

// NewFileProjectSkillService creates a file-backed ProjectSkillService.
func NewFileProjectSkillService(
	docStore domaindocsys.DocumentStore,
	folderRepo domaindocsys.FolderStore,
	namespaceSvc domaindocsys.NamespaceService,
	authorizer authdomain.ResourceAuthorizer,
	skillResolver domainagents.SkillResolver,
	txManager domain.TransactionManager,
	logger *slog.Logger,
) skilldomain.ProjectSkillService {
	return &fileProjectSkillService{
		docStore:      docStore,
		folderRepo:    folderRepo,
		namespaceSvc:  namespaceSvc,
		authorizer:    authorizer,
		skillResolver: skillResolver,
		txManager:     txManager,
		logger:        logger,
	}
}

// CreateSkill creates a new file-backed skill.
func (s *fileProjectSkillService) CreateSkill(ctx context.Context, userID string, req skilldomain.CreateSkillRequest) (*skilldomain.ProjectSkill, error) {
	if err := validateSkillName(req.Name); err != nil {
		return nil, err
	}
	if err := validateSkillDescription(req.Description); err != nil {
		return nil, err
	}
	if err := s.authorizer.CanAccessProject(ctx, userID, req.ProjectID); err != nil {
		return nil, err
	}

	projectUUID, err := parseProjectUUID(req.ProjectID)
	if err != nil {
		return nil, err
	}

	existing, issues, err := s.skillResolver.List(ctx, projectUUID)
	if err != nil {
		return nil, fmt.Errorf("list existing skills: %w", err)
	}
	if len(issues) > 0 {
		s.logger.Warn("skill validation issues encountered during create",
			"project_id", req.ProjectID,
			"issues", len(issues),
		)
	}
	nextPosition := len(existing)

	content := req.Content
	if content == "" {
		content = fmt.Sprintf("# %s\n\n<!-- Add your skill instructions here -->\n", req.Name)
	}

	now := time.Now().UTC()
	skill := &skilldomain.ProjectSkill{
		ProjectID: req.ProjectID,
		Name:      req.Name,
		// Enabled remains in the domain model for now but is no longer API-facing.
		Enabled:     true,
		Description: req.Description,
		Content:     content,
		Position:    nextPosition,
		SyncState:   skilldomain.SyncStateDetached,
		IsDirty:     false,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	skill.SetMetadata(skilldomain.SkillMetadata{
		DisableModelInvocation: req.DisableModelInvocation,
		UserInvocable:          req.UserInvocable,
	})

	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		instanceFolderID, folderErr := s.ensureSkillFolder(txCtx, skill)
		if folderErr != nil {
			return folderErr
		}
		skill.InstanceFolderID = instanceFolderID

		skillFolderID, folderErr := s.ensureAgentsSkillFolder(txCtx, req.ProjectID, req.Name)
		if folderErr != nil {
			return folderErr
		}

		path := fmt.Sprintf(".agents/skills/%s/SKILL.md", req.Name)
		_, getErr := s.docStore.GetByPath(txCtx, path, req.ProjectID)
		if getErr == nil {
			return &domain.ConflictError{
				Message:      fmt.Sprintf("a skill named %q already exists in this project", req.Name),
				ResourceType: "skill",
				ResourceID:   req.Name,
			}
		}
		var notFound *domain.NotFoundError
		if !errors.As(getErr, &notFound) {
			return fmt.Errorf("check existing SKILL.md: %w", getErr)
		}

		md, buildErr := buildSkillMDContent(skill)
		if buildErr != nil {
			return buildErr
		}

		doc := &domaindocsys.Document{
			ProjectID: req.ProjectID,
			FolderID:  &skillFolderID,
			Name:      "SKILL",
			Extension: ".md",
			Content:   md,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if createErr := s.docStore.Create(txCtx, doc); createErr != nil {
			return fmt.Errorf("create SKILL.md: %w", createErr)
		}
		skill.ID = doc.ID
		return nil
	})
	if err != nil {
		return nil, err
	}

	return skill, nil
}

// ListSkills lists all file-backed skills for a project.
func (s *fileProjectSkillService) ListSkills(ctx context.Context, userID, projectID string) ([]*skilldomain.ProjectSkill, error) {
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	projectUUID, err := parseProjectUUID(projectID)
	if err != nil {
		return nil, err
	}

	runtimeSkills, issues, err := s.skillResolver.List(ctx, projectUUID)
	if err != nil {
		return nil, err
	}
	if len(issues) > 0 {
		s.logger.Warn("skill validation issues encountered during list",
			"project_id", projectID,
			"issues", len(issues),
		)
	}

	out := make([]*skilldomain.ProjectSkill, 0, len(runtimeSkills))
	for i := range runtimeSkills {
		doc, getErr := s.docStore.GetByPath(ctx, runtimeSkills[i].SourcePath, projectID)
		if getErr != nil {
			return nil, fmt.Errorf("load skill document for %q: %w", runtimeSkills[i].Slug, getErr)
		}
		out = append(out, runtimeSkillToProjectSkill(projectID, &runtimeSkills[i], doc))
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Position == out[j].Position {
			return out[i].Name < out[j].Name
		}
		return out[i].Position < out[j].Position
	})

	return out, nil
}

// GetSkill resolves a skill by API identifier (document ID preferred, slug fallback).
func (s *fileProjectSkillService) GetSkill(ctx context.Context, userID, projectID, skillID string) (*skilldomain.ProjectSkill, error) {
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	projectUUID, err := parseProjectUUID(projectID)
	if err != nil {
		return nil, err
	}

	runtimeSkill, doc, err := s.resolveSkillByIdentifier(ctx, projectID, projectUUID, skillID)
	if err != nil {
		return nil, err
	}

	return runtimeSkillToProjectSkill(projectID, runtimeSkill, doc), nil
}

// UpdateSkill updates an existing file-backed skill.
func (s *fileProjectSkillService) UpdateSkill(ctx context.Context, userID, projectID, skillID string, req skilldomain.UpdateSkillRequest) (*skilldomain.ProjectSkill, error) {
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	projectUUID, err := parseProjectUUID(projectID)
	if err != nil {
		return nil, err
	}

	runtimeSkill, doc, err := s.resolveSkillByIdentifier(ctx, projectID, projectUUID, skillID)
	if err != nil {
		return nil, err
	}

	// Parse current SKILL.md preserving all frontmatter fields for round-trip safety.
	current, fm, body, parseErr := parseSkillDocumentFull(doc)
	if parseErr != nil {
		return nil, domainerrors.SkillInvalid(parseErr.Error())
	}
	oldName := runtimeSkill.Slug

	if req.Name != nil && *req.Name != current.Name {
		if err := validateSkillName(*req.Name); err != nil {
			return nil, err
		}
		current.Name = *req.Name
		fm.Name = *req.Name
	}
	if req.Description != nil {
		if err := validateSkillDescription(*req.Description); err != nil {
			return nil, err
		}
		current.Description = *req.Description
		fm.Description = *req.Description
	}
	if req.Content != nil {
		current.Content = *req.Content
		body = *req.Content
	}

	meta := current.GetMetadata()
	if req.DisableModelInvocation != nil {
		meta.DisableModelInvocation = *req.DisableModelInvocation
		fm.DisableModelInvocation = *req.DisableModelInvocation
	}
	if req.UserInvocable != nil {
		meta.UserInvocable = *req.UserInvocable
		fm.UserInvocable = req.UserInvocable
	}
	current.SetMetadata(meta)

	now := time.Now().UTC()
	current.UpdatedAt = now
	nameChanged := current.Name != oldName

	err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		if nameChanged {
			if renameErr := s.renameSkillFolders(txCtx, projectID, oldName, current.Name); renameErr != nil {
				return renameErr
			}
		}

		// Build from frontmatter struct directly to preserve version and other fields.
		md, buildErr := buildSkillMDFromFrontmatter(fm, body)
		if buildErr != nil {
			return buildErr
		}
		doc.Content = md
		doc.UpdatedAt = now
		if updateErr := s.docStore.Update(txCtx, doc); updateErr != nil {
			return fmt.Errorf("update SKILL.md: %w", updateErr)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	current.ID = doc.ID
	current.ProjectID = projectID
	current.CreatedAt = doc.CreatedAt
	current.UpdatedAt = now
	return current, nil
}

// ReorderSkills updates skill positions by rewriting SKILL.md frontmatter.
func (s *fileProjectSkillService) ReorderSkills(ctx context.Context, userID, projectID string, skillIDs []string) error {
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return err
	}

	projectUUID, err := parseProjectUUID(projectID)
	if err != nil {
		return err
	}

	runtimeSkills, issues, err := s.skillResolver.List(ctx, projectUUID)
	if err != nil {
		return err
	}
	if len(issues) > 0 {
		s.logger.Warn("skill validation issues encountered during reorder",
			"project_id", projectID,
			"issues", len(issues),
		)
	}

	if len(skillIDs) != len(runtimeSkills) {
		return domain.NewValidationErrorWithField(
			"skill_ids must include all skills in the project",
			"skill_ids",
		)
	}

	type skillEntry struct {
		runtime domainagents.RuntimeSkill
		doc     *domaindocsys.Document
	}
	byIdentifier := make(map[string]skillEntry, len(runtimeSkills)*2)
	for i := range runtimeSkills {
		doc, getErr := s.docStore.GetByPath(ctx, runtimeSkills[i].SourcePath, projectID)
		if getErr != nil {
			return fmt.Errorf("load skill document for %q: %w", runtimeSkills[i].Slug, getErr)
		}
		entry := skillEntry{runtime: runtimeSkills[i], doc: doc}
		byIdentifier[doc.ID] = entry
		if _, exists := byIdentifier[runtimeSkills[i].Slug]; !exists {
			byIdentifier[runtimeSkills[i].Slug] = entry
		}
	}

	seenDocIDs := make(map[string]bool, len(skillIDs))
	return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		now := time.Now().UTC()
		for i, identifier := range skillIDs {
			entry, ok := byIdentifier[identifier]
			if !ok {
				return domain.NewValidationErrorWithField(
					fmt.Sprintf("skill %q not found in project", identifier),
					"skill_ids",
				)
			}
			if seenDocIDs[entry.doc.ID] {
				return domain.NewValidationErrorWithField(
					fmt.Sprintf("duplicate skill %q in reorder payload", identifier),
					"skill_ids",
				)
			}
			seenDocIDs[entry.doc.ID] = true

			// Parse preserving all frontmatter fields; only update position.
			_, fm, body, parseErr := parseSkillDocumentFull(entry.doc)
			if parseErr != nil {
				return domainerrors.SkillInvalid(parseErr.Error())
			}
			pos := i
			fm.Position = &pos

			md, buildErr := buildSkillMDFromFrontmatter(fm, body)
			if buildErr != nil {
				return buildErr
			}
			entry.doc.Content = md
			entry.doc.UpdatedAt = now
			if updateErr := s.docStore.Update(txCtx, entry.doc); updateErr != nil {
				return fmt.Errorf("update SKILL.md for %q: %w", entry.runtime.Slug, updateErr)
			}
		}
		return nil
	})
}

// DeleteSkill deletes a file-backed skill document.
func (s *fileProjectSkillService) DeleteSkill(ctx context.Context, userID, projectID, skillID string) error {
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return err
	}

	projectUUID, err := parseProjectUUID(projectID)
	if err != nil {
		return err
	}

	runtimeSkill, doc, err := s.resolveSkillByIdentifier(ctx, projectID, projectUUID, skillID)
	if err != nil {
		return err
	}

	return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		// Hard-fail when SKILL.md cannot be removed.
		if err := s.docStore.Delete(txCtx, doc.ID, projectID); err != nil {
			return fmt.Errorf("delete SKILL.md: %w", err)
		}
		if err := s.deleteFolderIfExists(txCtx, projectID, fmt.Sprintf(".agents/skills/%s", runtimeSkill.Slug)); err != nil {
			return err
		}
		if err := s.deleteFolderIfExists(txCtx, projectID, fmt.Sprintf(".meridian/skills/%s", runtimeSkill.Slug)); err != nil {
			return err
		}
		return nil
	})
}

func (s *fileProjectSkillService) ensureAgentsSkillFolder(ctx context.Context, projectID, slug string) (string, error) {
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

func (s *fileProjectSkillService) ensureSkillFolder(ctx context.Context, skill *skilldomain.ProjectSkill) (string, error) {
	skillsFolder, err := s.namespaceSvc.EnsureMeridianSubfolder(ctx, skill.ProjectID, "skills")
	if err != nil {
		return "", err
	}

	newFolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, skill.ProjectID, &skillsFolder.ID, skill.Name)
	if err != nil {
		return "", err
	}

	return newFolder.ID, nil
}

func (s *fileProjectSkillService) renameSkillFolders(ctx context.Context, projectID, oldName, newName string) error {
	oldAgentsPath := fmt.Sprintf(".agents/skills/%s", oldName)
	newAgentsPath := fmt.Sprintf(".agents/skills/%s", newName)

	if oldName == newName {
		return nil
	}

	// Name uniqueness is enforced by one slug folder in .agents/skills/.
	if _, err := s.folderRepo.GetByPath(ctx, projectID, newAgentsPath); err == nil {
		return &domain.ConflictError{
			Message:      fmt.Sprintf("a skill named %q already exists in this project", newName),
			ResourceType: "skill",
			ResourceID:   newName,
		}
	} else {
		var notFound *domain.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("check destination skill folder: %w", err)
		}
	}

	agentsFolder, err := s.folderRepo.GetByPath(ctx, projectID, oldAgentsPath)
	if err != nil {
		return fmt.Errorf("find source skill folder: %w", err)
	}
	agentsFolder.Name = newName
	agentsFolder.UpdatedAt = time.Now().UTC()
	if err := s.folderRepo.Update(ctx, agentsFolder); err != nil {
		return fmt.Errorf("rename .agents skill folder: %w", err)
	}

	oldMeridianPath := fmt.Sprintf(".meridian/skills/%s", oldName)
	newMeridianPath := fmt.Sprintf(".meridian/skills/%s", newName)

	meridianFolder, err := s.folderRepo.GetByPath(ctx, projectID, oldMeridianPath)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			_, ensureErr := s.ensureSkillFolder(ctx, &skilldomain.ProjectSkill{
				ProjectID: projectID,
				Name:      newName,
			})
			return ensureErr
		}
		return fmt.Errorf("find .meridian skill folder: %w", err)
	}

	if _, err := s.folderRepo.GetByPath(ctx, projectID, newMeridianPath); err == nil {
		return &domain.ConflictError{
			Message:      fmt.Sprintf("a skill named %q already exists in this project", newName),
			ResourceType: "skill",
			ResourceID:   newName,
		}
	} else {
		var notFound *domain.NotFoundError
		if !errors.As(err, &notFound) {
			return fmt.Errorf("check destination meridian folder: %w", err)
		}
	}

	meridianFolder.Name = newName
	meridianFolder.UpdatedAt = time.Now().UTC()
	if err := s.folderRepo.Update(ctx, meridianFolder); err != nil {
		return fmt.Errorf("rename .meridian skill folder: %w", err)
	}

	return nil
}

func (s *fileProjectSkillService) deleteFolderIfExists(ctx context.Context, projectID, path string) error {
	folder, err := s.folderRepo.GetByPath(ctx, projectID, path)
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil
		}
		return fmt.Errorf("find folder %q: %w", path, err)
	}
	if err := s.folderRepo.Delete(ctx, folder.ID, projectID); err != nil {
		return fmt.Errorf("delete folder %q: %w", path, err)
	}
	return nil
}

func (s *fileProjectSkillService) resolveSkillByIdentifier(
	ctx context.Context,
	projectID string,
	projectUUID uuid.UUID,
	identifier string,
) (*domainagents.RuntimeSkill, *domaindocsys.Document, error) {
	doc, err := s.docStore.GetByID(ctx, identifier, projectID)
	if err == nil {
		path, pathErr := s.docStore.GetPath(ctx, doc)
		if pathErr != nil {
			return nil, nil, fmt.Errorf("resolve skill document path: %w", pathErr)
		}
		slug, ok := skillSlugFromPath(path)
		if !ok {
			return nil, nil, domainerrors.SkillNotFound(identifier)
		}
		runtimeSkill, resolveErr := s.skillResolver.Resolve(ctx, projectUUID, slug)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		return runtimeSkill, doc, nil
	}

	var notFound *domain.NotFoundError
	if !errors.As(err, &notFound) {
		return nil, nil, fmt.Errorf("load skill document: %w", err)
	}

	// Backward-compatible fallback: treat identifier as slug.
	runtimeSkill, resolveErr := s.skillResolver.Resolve(ctx, projectUUID, identifier)
	if resolveErr != nil {
		return nil, nil, resolveErr
	}
	doc, getErr := s.docStore.GetByPath(ctx, runtimeSkill.SourcePath, projectID)
	if getErr != nil {
		return nil, nil, fmt.Errorf("load skill document at %q: %w", runtimeSkill.SourcePath, getErr)
	}
	return runtimeSkill, doc, nil
}

func runtimeSkillToProjectSkill(projectID string, runtimeSkill *domainagents.RuntimeSkill, doc *domaindocsys.Document) *skilldomain.ProjectSkill {
	now := time.Now().UTC()
	createdAt := now
	updatedAt := now
	id := runtimeSkill.Slug
	if doc != nil {
		id = doc.ID
		createdAt = doc.CreatedAt
		updatedAt = doc.UpdatedAt
	}

	position := 0
	if runtimeSkill.Position != nil {
		position = *runtimeSkill.Position
	}

	meta := skilldomain.DefaultSkillMetadata()
	meta.DisableModelInvocation = runtimeSkill.DisableModelInvocation
	meta.UserInvocable = domainagents.BoolDefaultTrue(runtimeSkill.UserInvocable)

	out := &skilldomain.ProjectSkill{
		ID:          id,
		ProjectID:   projectID,
		Name:        runtimeSkill.Name,
		Description: runtimeSkill.Description,
		Content:     runtimeSkill.Content,
		Position:    position,
		Enabled:     true,
		SyncState:   skilldomain.SyncStateDetached,
		IsDirty:     false,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
	}
	out.SetMetadata(meta)
	return out
}

// parseSkillDocumentFull parses a SKILL.md document into both the raw frontmatter
// (for round-trip writes that preserve all fields) and a ProjectSkill (for API responses).
func parseSkillDocumentFull(doc *domaindocsys.Document) (*skilldomain.ProjectSkill, *skillMDFrontmatter, string, error) {
	fm, body, err := frontmatter.ParseInto[skillMDFrontmatter](doc.Content)
	if err != nil {
		return nil, nil, "", fmt.Errorf("invalid SKILL.md frontmatter: %w", err)
	}
	if fm.Name == "" {
		return nil, nil, "", fmt.Errorf("invalid SKILL.md frontmatter: missing required field name")
	}

	position := 0
	if fm.Position != nil {
		position = *fm.Position
	}

	meta := skilldomain.DefaultSkillMetadata()
	if fm.UserInvocable != nil {
		meta.UserInvocable = *fm.UserInvocable
	}
	meta.DisableModelInvocation = fm.DisableModelInvocation

	skill := &skilldomain.ProjectSkill{
		ID:          doc.ID,
		ProjectID:   doc.ProjectID,
		Name:        fm.Name,
		Description: fm.Description,
		Content:     body,
		Position:    position,
		Enabled:     true,
		SyncState:   skilldomain.SyncStateDetached,
		IsDirty:     false,
		CreatedAt:   doc.CreatedAt,
		UpdatedAt:   doc.UpdatedAt,
	}
	skill.SetMetadata(meta)
	return skill, &fm, body, nil
}

func parseSkillDocument(doc *domaindocsys.Document) (*skilldomain.ProjectSkill, error) {
	skill, _, _, err := parseSkillDocumentFull(doc)
	return skill, err
}

// buildSkillMDFromFrontmatter serializes a frontmatter struct + body into SKILL.md format.
// Preserves all frontmatter fields (including version and future unknown fields parsed by
// the struct) for round-trip-safe writes.
func buildSkillMDFromFrontmatter(fm *skillMDFrontmatter, body string) (string, error) {
	yamlBytes, err := yaml.Marshal(fm)
	if err != nil {
		return "", fmt.Errorf("marshal skill frontmatter: %w", err)
	}
	return "---\n" + string(yamlBytes) + "---\n" + body, nil
}

func parseProjectUUID(projectID string) (uuid.UUID, error) {
	projectUUID, err := uuid.Parse(projectID)
	if err != nil {
		return uuid.Nil, domain.NewValidationErrorWithField(
			"project ID must be a valid UUID",
			"project_id",
		)
	}
	return projectUUID, nil
}

func skillSlugFromPath(path string) (string, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) != 4 {
		return "", false
	}
	if parts[0] != ".agents" || parts[1] != "skills" || parts[3] != "SKILL.md" || parts[2] == "" {
		return "", false
	}
	return parts[2], true
}
