# Marketplace Unification: CLI + Flow

## Vision

One marketplace, two install targets. Agent/skill packages distribute to:
1. **CLI harnesses** (Claude Code, Cursor, etc.) via `meridian install`
2. **Meridian Flow** (web UI) via project install flow

## Current State

### CLI Side
- Agents: `.agents/agents/<name>.md` (frontmatter: name, description, model, skills, sandbox)
- Skills: `.agents/skills/<name>/SKILL.md` (frontmatter: name, description) + optional `resources/`
- Distribution: git repos, `meridian install`, tracked in `agents.toml` / `agents.lock`
- Already works, actively used

### Flow Side (from agent-framework.md design)
- Skills: `.meridian/skills/<name>/` with `SKILL.md` + `references/`, DB-backed metadata, revision model
- Personas: DB record (model + reasoning + system prompt + skills + available agents)
- Agents: built-in only v1, code-defined
- Not yet implemented

## Unification Points

### Package Format (shared)
- `SKILL.md` with frontmatter is already the common unit
- Directory structure: `SKILL.md` + `resources/` (standard for both CLI and Flow)
- Agent profiles: `.md` with frontmatter works for both

### Distribution (converge)
- **Now**: git repos via `meridian install`
- **Near-term**: registry/marketplace that wraps git repos with metadata (search, ratings, categories)
- **Install target**: CLI (`meridian install --target cli`) or Flow (`meridian install --target flow` or via web UI)

### Key Differences to Resolve
| Aspect | CLI | Flow | Resolution |
|--------|-----|------|------------|
| Metadata storage | Filesystem (agents.toml) | DB (project_skills table) | Install adapter per target |
| Revision model | Git (implicit via repo) | DB-backed revisions + active pointer | Flow adds audit layer on top |
| Resource dir name | `resources/` | `resources/` | Standardized |
| AI editability | N/A (CLI agents don't self-edit) | Configurable (manual/auto-safe/auto-all) | Flow-only concern |
| Personas | N/A (model set in agent profile) | Full persona entity (model + skills + agents) | Personas are Flow-only for now |

## Open Questions
- Should the marketplace be a separate service or built into Meridian Flow?
- Auth model: public packages vs private packages vs org-scoped?
- Versioning: semver? or just "latest from git"?
- How does BYOK interact with marketplace agents that specify a model?
- Revenue model: free marketplace, paid premium packages, or platform cut?
