package agents

import (
	"context"

	"github.com/google/uuid"
)

// SkillResolver is the file-only skill catalog. It is the single source of
// truth for runtime skill data consumed by skill_list, skill_invoke, prompt
// injection, and the /skill slash command.
//
// Skills are read exclusively from .agents/skills/<slug>/SKILL.md.
//
// If a file exists but is invalid, the resolver returns a validation error
// and callers must surface the error.
type SkillResolver interface {
	// Resolve returns the runtime view of a single skill by slug.
	// Returns a validation error if a file copy exists but is malformed.
	Resolve(ctx context.Context, projectID uuid.UUID, slug string) (*RuntimeSkill, error)

	// List returns all valid skills and any validation issues encountered
	// during enumeration. Invalid file-backed entries are excluded from the
	// first return value and included in the second.
	List(ctx context.Context, projectID uuid.UUID) ([]RuntimeSkill, []ValidationIssue, error)
}

// PersonaCatalog resolves persona profiles from .agents/agents/*.md.
// It does not fall back to any legacy table — agents are file-only in Phase 1.
type PersonaCatalog interface {
	// ResolvePersona returns the persona for the given slug, or an error if
	// the file does not exist or contains invalid frontmatter.
	ResolvePersona(ctx context.Context, projectID uuid.UUID, slug string) (*Persona, error)

	// ListUserPersonas returns all personas with UserInvocable=true, plus
	// any validation issues found during enumeration.
	ListUserPersonas(ctx context.Context, projectID uuid.UUID) ([]Persona, []ValidationIssue, error)

	// ListSpawnablePersonas returns all personas that other agents may spawn
	// (i.e. DisableModelInvocation=false), plus any validation issues.
	ListSpawnablePersonas(ctx context.Context, projectID uuid.UUID) ([]Persona, []ValidationIssue, error)
}

// AgentImportService handles git-based installation of agent bundles into a
// project's .agents/ namespace. On failure the entire import is rolled back
// atomically; no partial files are written.
type AgentImportService interface {
	// ImportFromGit clones the repository at url, validates its contents,
	// and writes the agent and skill files into the project's document tree.
	ImportFromGit(ctx context.Context, projectID uuid.UUID, url string) error
}

// GitFetcher is a low-level git utility used by AgentImportService.
// It is separated so callers can swap in test doubles without touching
// the broader import logic.
type GitFetcher interface {
	// ValidateURL checks that the URL is an acceptable git remote before
	// any network activity (allowlist, scheme check, SSRF guards).
	ValidateURL(url string) error

	// Clone fetches the repository into a temporary directory and returns
	// its path. The caller is responsible for cleaning up the directory
	// when done.
	Clone(ctx context.Context, url string) (string, error)
}
