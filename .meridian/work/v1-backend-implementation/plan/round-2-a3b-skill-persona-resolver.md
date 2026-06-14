# Phase A3b: Skill Resolver + Persona Catalog Implementations

## Scope
Implement the SkillResolver and PersonaCatalog interfaces from A3a — file-only resolution from `.agents/` directory.

## Intent
These are the runtime resolvers that all downstream steps depend on: SM (skill migration), P1 (persona catalog service), P4 (skill override).

## Dependencies
- A3a must complete first (domain types, interfaces, frontmatter parser)

## Files to Create
- `backend/internal/service/agents/skill_resolver.go` — SkillResolver implementation
- `backend/internal/service/agents/persona_catalog.go` — PersonaCatalog implementation
- `backend/internal/service/agents/skill_resolver_test.go` — unit tests
- `backend/internal/service/agents/persona_catalog_test.go` — unit tests

## SkillResolver Implementation
Reads `.agents/skills/<slug>/SKILL.md` files via DocumentRepository (existing file access layer).

```go
type fileSkillResolver struct {
    docRepo docsystem.DocumentRepository
    logger  *slog.Logger
}
```

- Resolve(ctx, projectID, slug): read file at `.agents/skills/<slug>/SKILL.md`, parse frontmatter with pkg/frontmatter, build RuntimeSkill. Missing file → SKILL_NOT_FOUND error. Invalid frontmatter → SKILL_INVALID error. No silent fallback.
- List(ctx, projectID): read all files under `.agents/skills/`, parse each, return valid skills + validation issues for invalid ones. Deduplicate by slug.

## PersonaCatalog Implementation
Reads `.agents/agents/*.md` files.

```go
type filePersonaCatalog struct {
    docRepo docsystem.DocumentRepository
    logger  *slog.Logger
}
```

- ResolvePersona(ctx, projectID, slug): read `.agents/agents/<slug>.md`, parse frontmatter into Persona struct. Missing → PERSONA_NOT_FOUND. Invalid → PERSONA_INVALID.
- ListUserPersonas(ctx, projectID): list all, filter by UserInvocable (use BoolDefaultTrue helper from A3a).
- ListSpawnablePersonas(ctx, projectID): list all, filter by !DisableModelInvocation.

## Key Details
- File-only: NO database fallback. Files are the source of truth.
- Use `pkg/frontmatter.ParseInto[T]()` for typed parsing.
- Use `domain/agents.BoolDefaultTrue()` for *bool fields with default-true semantics.
- Invalid files return validation issues, not panics.
- Skills references in personas should be validated against the file tree.

## Patterns to Follow
- See `backend/internal/service/skill/project_skill_service.go` for existing skill service pattern
- See `backend/internal/repository/postgres/docsystem/document_store.go` for DocumentRepository
- See `backend/internal/domain/agents/types.go` for Persona, RuntimeSkill types
- See `backend/internal/domain/agents/interfaces.go` for interfaces to implement

## Verification Criteria
- [ ] `make test` passes
- [ ] File-backed skill resolves correctly
- [ ] Missing file → SKILL_NOT_FOUND error
- [ ] Invalid file → SKILL_INVALID error (no silent fallback)
- [ ] Persona catalog returns valid personas + invalid entries separately
- [ ] ListUserPersonas excludes personas where BoolDefaultTrue(UserInvocable) is false
- [ ] ListSpawnablePersonas excludes personas where DisableModelInvocation is true
- [ ] Frontmatter parsing uses shared parser from A3a
- [ ] `go vet ./...` clean
