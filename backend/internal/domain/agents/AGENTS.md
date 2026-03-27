# Agents Domain

Types and interfaces for the `.agents/` namespace — personas, skills, and the catalog services that resolve them from the document tree. Import: `meridian/internal/domain/agents`. Deep dive: `.meridian/fs/backend/agents/`.

## Key Concepts

- **File-only resolution**: All runtime agent data lives in `.agents/` within the project's document tree. No DB fallback for resolution.
- **Persona** (`.agents/agents/<slug>.md`): Agent profile with model routing, tool filtering, skill loading, and invocation policy. Slug derived from filename, not frontmatter.
- **RuntimeSkill** (`.agents/skills/<slug>/SKILL.md`): Skill content + invocation policy. Directory-per-skill layout enables co-located assets.
- `***bool` for UserInvocable**: YAML omission (nil) is distinct from explicit `false`. Callers use `BoolDefaultTrue()` to get the default-true behavior. Only used for `UserInvocable`.
- `**DisableModelInvocation`**: Plain `bool` — Go's zero value (`false`) matches the correct default (model invocation allowed).

## Interfaces


| Interface            | Purpose                                                  | File            |
| -------------------- | -------------------------------------------------------- | --------------- |
| `SkillResolver`      | File-only skill catalog (resolve by slug, list all)      | `interfaces.go` |
| `PersonaCatalog`     | Persona resolution + listing (user-invocable, spawnable) | `interfaces.go` |
| `AgentImportService` | Git-based `.agents/` bundle installation (atomic)        | `interfaces.go` |
| `BackfillService`    | DB-to-file SKILL.md migration (idempotent)               | `interfaces.go` |
| `GitFetcher`         | URL validation + shallow clone with SSRF guards          | `interfaces.go` |


## Types


| Type              | Purpose                                               | File       |
| ----------------- | ----------------------------------------------------- | ---------- |
| `Persona`         | Agent profile loaded from frontmatter + markdown body | `types.go` |
| `RuntimeSkill`    | Skill loaded from SKILL.md frontmatter + content      | `types.go` |
| `ValidationIssue` | Per-file problem during catalog enumeration           | `types.go` |


## Conventions

- `ResolvePersona` hard-fails on invalid personas (execution time). `ListUserPersonas` soft-fails (catalog display) and returns issues separately.
- Compile-time assertions: `var _ Interface = (*impl)(nil)` in every implementation.
- Missing `.agents/` folder = empty catalog, not error.

