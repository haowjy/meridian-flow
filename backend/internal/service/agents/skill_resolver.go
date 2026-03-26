// Package agents provides file-backed implementations of the domain/agents
// catalog interfaces. All resolution is file-only — no DB fallback.
package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	"meridian/internal/domain"
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
	"meridian/internal/pkg/frontmatter"
)

// skillFrontmatter is the typed struct for parsing SKILL.md frontmatter.
// A separate struct (rather than RuntimeSkill directly) is needed because
// RuntimeSkill has no yaml tags — its JSON tags use underscores whereas the
// SKILL.md spec mandates hyphen-separated field names.
type skillFrontmatter struct {
	Name                   string  `yaml:"name"`
	Description            string  `yaml:"description"`
	UserInvocable          *bool   `yaml:"user-invocable"`
	DisableModelInvocation bool    `yaml:"disable-model-invocation"`
	Position               *int    `yaml:"position"`
	Version                *string `yaml:"version"`
}

// fileSkillResolver implements domain/agents.SkillResolver backed by the
// .agents/skills/ document tree. File-only — no DB fallback. If a SKILL.md
// exists but contains invalid frontmatter, Resolve returns SKILL_INVALID and
// does NOT silently fall through to any other source.
type fileSkillResolver struct {
	docRepo    domaindocsys.DocumentReader
	folderRepo domaindocsys.FolderStore
	logger     *slog.Logger
}

// Compile-time interface assertion.
var _ domainagents.SkillResolver = (*fileSkillResolver)(nil)

// NewFileSkillResolver creates a SkillResolver backed by the .agents/
// document tree. Both docRepo and folderRepo are required.
func NewFileSkillResolver(
	docRepo domaindocsys.DocumentReader,
	folderRepo domaindocsys.FolderStore,
	logger *slog.Logger,
) domainagents.SkillResolver {
	return &fileSkillResolver{
		docRepo:    docRepo,
		folderRepo: folderRepo,
		logger:     logger,
	}
}

// Resolve returns the runtime view of a single skill by slug.
//
// Returns domainerrors.SkillNotFound when the SKILL.md file does not exist,
// and domainerrors.SkillInvalid when it exists but has malformed frontmatter.
// No silent fallback.
func (r *fileSkillResolver) Resolve(ctx context.Context, projectID uuid.UUID, slug string) (*domainagents.RuntimeSkill, error) {
	path := fmt.Sprintf(".agents/skills/%s/SKILL.md", slug)

	doc, err := r.docRepo.GetByPath(ctx, path, projectID.String())
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			return nil, domainerrors.SkillNotFound(slug)
		}
		return nil, fmt.Errorf("skill resolver: read %s: %w", path, err)
	}

	skill, parseErr := parseSkillDoc(doc, slug, path)
	if parseErr != nil {
		r.logger.Warn("skill file invalid",
			"slug", slug,
			"path", path,
			"error", parseErr,
		)
		return nil, domainerrors.SkillInvalid(parseErr.Error())
	}

	return skill, nil
}

// List enumerates all skills under .agents/skills/ and returns:
//   - valid skills parsed without error
//   - validation issues for any folder that has no SKILL.md or an invalid one
//
// Invalid entries are excluded from the first return value and appended to the
// second. Duplicates (same slug) are silently dropped after the first occurrence.
// If the .agents/skills/ folder does not exist, (nil, nil, nil) is returned.
func (r *fileSkillResolver) List(ctx context.Context, projectID uuid.UUID) ([]domainagents.RuntimeSkill, []domainagents.ValidationIssue, error) {
	skillsFolder, err := r.folderRepo.GetByPath(ctx, projectID.String(), ".agents/skills")
	if err != nil {
		var notFound *domain.NotFoundError
		if errors.As(err, &notFound) {
			// No skills folder yet — not an error, just no skills.
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("skill resolver: locate skills folder: %w", err)
	}

	// List immediate child folders; each represents one skill slug directory.
	// IncludeHidden is true because skill folders may be created as hidden by
	// the backfill service.
	children, err := r.folderRepo.ListChildren(ctx, &skillsFolder.ID, projectID.String(),
		&domaindocsys.FolderFilterOptions{IncludeHidden: true})
	if err != nil {
		return nil, nil, fmt.Errorf("skill resolver: list skill folders: %w", err)
	}

	var skills []domainagents.RuntimeSkill
	var issues []domainagents.ValidationIssue
	seen := make(map[string]bool)

	for _, child := range children {
		slug := child.Name
		if seen[slug] {
			continue // deduplicate by slug
		}
		seen[slug] = true

		path := fmt.Sprintf(".agents/skills/%s/SKILL.md", slug)

		doc, err := r.docRepo.GetByPath(ctx, path, projectID.String())
		if err != nil {
			var notFound *domain.NotFoundError
			if errors.As(err, &notFound) {
				// Folder exists but SKILL.md is absent — record as issue.
				issues = append(issues, domainagents.ValidationIssue{
					Path:    path,
					Message: "SKILL.md not found in skill folder",
				})
				continue
			}
			return nil, nil, fmt.Errorf("skill resolver: read %s: %w", path, err)
		}

		skill, parseErr := parseSkillDoc(doc, slug, path)
		if parseErr != nil {
			issues = append(issues, domainagents.ValidationIssue{
				Path:    path,
				Message: parseErr.Error(),
			})
			r.logger.Warn("skill file invalid, skipping",
				"slug", slug,
				"path", path,
				"error", parseErr,
			)
			continue
		}
		skills = append(skills, *skill)
	}

	return skills, issues, nil
}

// parseSkillDoc parses the content of a SKILL.md document into a RuntimeSkill.
// Returns an error (but never panics) when frontmatter is missing or invalid,
// or when required fields (name) are absent.
func parseSkillDoc(doc *domaindocsys.Document, slug, path string) (*domainagents.RuntimeSkill, error) {
	fm, body, err := frontmatter.ParseInto[skillFrontmatter](doc.Content)
	if err != nil {
		return nil, fmt.Errorf("invalid frontmatter: %w", err)
	}

	if fm.Name == "" {
		return nil, fmt.Errorf("missing required field: name")
	}

	return &domainagents.RuntimeSkill{
		Slug:                   slug,
		Name:                   fm.Name,
		Description:            fm.Description,
		Content:                body,
		UserInvocable:          fm.UserInvocable,
		DisableModelInvocation: fm.DisableModelInvocation,
		Position:               fm.Position,
		Version:                fm.Version,
		Source:                 "file",
		SourcePath:             path,
	}, nil
}
