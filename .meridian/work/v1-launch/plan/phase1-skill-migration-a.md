# Phase 1: Skill Migration A — File-Backed ProjectSkillService

## Problem
Runtime uses files exclusively (SkillResolver reads SKILL.md), but CRUD is DB-first with best-effort file sync. When a file write fails, DB still succeeds — the system silently disagrees with itself. The `enabled` field exists in DB/API but has zero runtime effect.

## Scope
Replace the DB-first ProjectSkillService with a file-backed implementation. CRUD operations write to `.agents/skills/<slug>/SKILL.md` as the source of truth, failing if file persistence fails (no more warn-and-continue). Remove `enabled` from the API.

## Architecture Decision
The existing `fileSkillResolver` (in service/agents/) already knows how to read SKILL.md. The new file-backed service will use the same codec for writes. The DB remains for now (Phase B removes it) — we just flip which is authoritative.

## Files to Create
- `backend/internal/service/skill/file_project_skill.go` — new file-backed service implementation

## Files to Modify
- `backend/internal/service/skill/project_skill.go` — extract shared SKILL.md codec into reusable functions (or keep in file_project_skill.go)
- `backend/internal/service/agents/skill_resolver.go` — extract shared frontmatter codec if not already reusable
- `backend/internal/handler/project_skill_dto.go` — remove `enabled` from API DTOs
- `backend/internal/handler/project_skill.go` — remove `enabled` handling from update
- `backend/internal/app/domains/skill.go` — wire file-backed service instead of DB-first

## Current SKILL.md Format (preserve this)
```yaml
---
name: writing-coach
description: Help with writing
user-invocable: false     # optional, default true
disable-model-invocation: true  # optional, default false
position: 0               # optional
---

Skill content here (markdown instructions)
```

## Implementation Plan

### Step 1: Extract shared SKILL.md codec
The skill service (`project_skill.go`) already has `buildSkillMDContent()` and `skillMDFrontmatter`. The resolver has its own `skillFrontmatter`. Unify into a shared codec:
- `WriteSkillMD(name, description, content string, metadata SkillMetadata, position int) string`
- `ParseSkillMD(raw string) (name, description, content string, metadata, error)`

### Step 2: Implement file-backed service
New `FileProjectSkillService` that:
- **Create**: Writes SKILL.md to `.agents/skills/<slug>/SKILL.md`. Fails if file write fails.
- **Update**: Reads current SKILL.md, applies updates, writes back. Fails if file write fails.
- **Delete**: Removes SKILL.md file. Fails if file removal fails.
- **List**: Delegates to SkillResolver.List() (already file-backed).
- **Get**: Delegates to SkillResolver.Resolve() (already file-backed).
- **Reorder**: Reads all SKILL.md files, updates position frontmatter, writes back.

Still needs: document store for file I/O (uses docsystem for file operations within project).

### Step 3: Remove `enabled` from API
- Remove `enabled` from SkillResponse, SkillWithContentResponse, UpdateSkillRequest
- Remove `enabled` handling in handler/service
- Remove DB index `idx_*_project_skills_enabled`

### Step 4: Wire new service
- In `domains/skill.go`, create `FileProjectSkillService` instead of DB-first service
- Keep DB service available (Phase B removes it)

## Dependencies
- Existing docsystem document/folder services for file I/O
- Existing SkillResolver for reads (List/Get)
- Existing namespace service for `.agents/` folder resolution

## Constraints
- SKILL.md format must be unchanged (same frontmatter fields, same codec)
- File operations must go through docsystem (not raw filesystem) — the project's document tree
- Authorization still required (project membership checks)
- Name uniqueness enforced by filesystem (one slug = one directory)

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] Create/Update/Delete fail when file write fails (not warn-and-continue)
- [ ] `enabled` removed from API responses and requests
- [ ] List/Get return the same data as before (file-backed reads)
- [ ] Reorder updates position in SKILL.md frontmatter
