// Package agents provides file-backed implementations of the domain/agents
// catalog interfaces. This file implements the BackfillService that migrates
// legacy project_skills DB rows to .agents/skills/<slug>/SKILL.md files.
package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	skilldomain "meridian/internal/domain/skill"
)

// skillMDFrontmatter is the output struct for generating SKILL.md frontmatter.
// Yaml tags use hyphen-separated names to match the SKILL.md spec consumed
// by skillFrontmatter (the reader-side struct in skill_resolver.go).
type skillMDFrontmatter struct {
	Name           string `yaml:"name"`
	Description    string `yaml:"description,omitempty"`
	Enabled        *bool  `yaml:"enabled,omitempty"`
	UserInvocable  *bool  `yaml:"user-invocable,omitempty"`
	ModelInvocable *bool  `yaml:"model-invocable,omitempty"`
	Position       *int   `yaml:"position,omitempty"`
}

// buildSkillMDContent generates the full SKILL.md content from a legacy ProjectSkill.
// Format: "---\n<YAML frontmatter>\n---\n<skill body>".
//
// Non-default field values are omitted so SKILL.md stays minimal. Defaults:
//   - enabled: true → omitted when true
//   - user-invocable: true → omitted when true
//   - model-invocable: true → omitted when DisableModelInvocation is false
func buildSkillMDContent(skill *skilldomain.ProjectSkill) (string, error) {
	meta := skill.GetMetadata()

	fm := skillMDFrontmatter{
		Name:        skill.Name,
		Description: skill.Description,
	}

	// enabled: only emit when false (default true)
	if !skill.Enabled {
		f := false
		fm.Enabled = &f
	}

	// user-invocable: only emit when false (default true)
	if !meta.UserInvocable {
		f := false
		fm.UserInvocable = &f
	}

	// model-invocable: only emit when false (default true)
	if meta.DisableModelInvocation {
		f := false
		fm.ModelInvocable = &f
	}

	// position: only emit non-zero
	if skill.Position > 0 {
		p := skill.Position
		fm.Position = &p
	}

	yamlBytes, err := yaml.Marshal(fm)
	if err != nil {
		return "", fmt.Errorf("marshal skill frontmatter: %w", err)
	}

	// yaml.Marshal appends a trailing newline, so "---\n<yaml>---\n<body>" is correct.
	return "---\n" + string(yamlBytes) + "---\n" + skill.Content, nil
}

// backfillService implements domain/agents.BackfillService.
// It reads from the legacy project_skills table and writes SKILL.md files
// into .agents/skills/<slug>/ in the document tree.
type backfillService struct {
	skillRepo  skilldomain.ProjectSkillStore
	docStore   domaindocsys.DocumentStore
	folderRepo domaindocsys.FolderStore
	logger     *slog.Logger
}

// Compile-time interface assertion.
var _ domainagents.BackfillService = (*backfillService)(nil)

// NewBackfillService creates a BackfillService backed by the given repositories.
func NewBackfillService(
	skillRepo skilldomain.ProjectSkillStore,
	docStore domaindocsys.DocumentStore,
	folderRepo domaindocsys.FolderStore,
	logger *slog.Logger,
) domainagents.BackfillService {
	return &backfillService{
		skillRepo:  skillRepo,
		docStore:   docStore,
		folderRepo: folderRepo,
		logger:     logger,
	}
}

// BackfillSkills creates .agents/skills/<slug>/SKILL.md for every active skill
// in the project that does not already have a file copy. Safe to re-run —
// skills that already have a SKILL.md are skipped without modification.
func (s *backfillService) BackfillSkills(ctx context.Context, projectID uuid.UUID) error {
	projectIDStr := projectID.String()

	skills, err := s.skillRepo.ListByProject(ctx, projectIDStr)
	if err != nil {
		return fmt.Errorf("backfill: list skills for project %s: %w", projectIDStr, err)
	}

	if len(skills) == 0 {
		s.logger.Info("backfill: no skills to migrate", "project_id", projectIDStr)
		return nil
	}

	// Ensure the .agents/ root system folder exists.
	agentsFolder, err := s.folderRepo.CreateSystemIfNotExists(ctx, projectIDStr, ".agents", nil)
	if err != nil {
		return fmt.Errorf("backfill: ensure .agents folder: %w", err)
	}

	// Ensure the .agents/skills/ container folder exists.
	skillsFolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, projectIDStr, &agentsFolder.ID, "skills")
	if err != nil {
		return fmt.Errorf("backfill: ensure .agents/skills folder: %w", err)
	}

	var errs []string
	migrated := 0
	skipped := 0

	for _, skill := range skills {
		path := fmt.Sprintf(".agents/skills/%s/SKILL.md", skill.Name)

		// Idempotency guard: skip if SKILL.md already exists.
		_, existErr := s.docStore.GetByPath(ctx, path, projectIDStr)
		if existErr == nil {
			skipped++
			s.logger.Debug("backfill: SKILL.md already exists, skipping",
				"skill_name", skill.Name,
				"path", path,
			)
			continue
		}

		var notFound *domain.NotFoundError
		if !errors.As(existErr, &notFound) {
			errs = append(errs, fmt.Sprintf("skill %q: check existing file: %v", skill.Name, existErr))
			continue
		}

		// Ensure per-skill folder (.agents/skills/<slug>/).
		skillFolder, folderErr := s.folderRepo.CreateHiddenIfNotExists(
			ctx, projectIDStr, &skillsFolder.ID, skill.Name,
		)
		if folderErr != nil {
			errs = append(errs, fmt.Sprintf("skill %q: ensure folder: %v", skill.Name, folderErr))
			continue
		}

		// Generate SKILL.md content from the legacy DB record.
		content, contentErr := buildSkillMDContent(skill)
		if contentErr != nil {
			errs = append(errs, fmt.Sprintf("skill %q: build content: %v", skill.Name, contentErr))
			continue
		}

		// Write the SKILL.md document.
		now := time.Now().UTC()
		doc := &domaindocsys.Document{
			ProjectID: projectIDStr,
			FolderID:  &skillFolder.ID,
			Name:      "SKILL",
			Extension: ".md",
			Content:   content,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if createErr := s.docStore.Create(ctx, doc); createErr != nil {
			errs = append(errs, fmt.Sprintf("skill %q: write file: %v", skill.Name, createErr))
			continue
		}

		migrated++
		s.logger.Info("backfill: skill migrated to file",
			"skill_name", skill.Name,
			"path", path,
		)
	}

	s.logger.Info("backfill complete",
		"project_id", projectIDStr,
		"total", len(skills),
		"migrated", migrated,
		"skipped", skipped,
		"errors", len(errs),
	)

	if len(errs) > 0 {
		return fmt.Errorf("backfill: %d skill(s) failed: %s", len(errs), strings.Join(errs, "; "))
	}

	return nil
}
