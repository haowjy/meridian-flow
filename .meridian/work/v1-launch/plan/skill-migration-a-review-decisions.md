# Skill Migration A Review Decisions

Reviewer: GPT-5.4 (p543) — request changes
Verification: GPT-5.3 (p542) — 61 tests pass, build + vet clean

## Findings and Decisions

### FIXED: Write codec drops version field (HIGH)
The write-side frontmatter struct didn't include `version`, so updating or reordering a skill would strip it from SKILL.md. Fixed by:
1. Adding `Version *string` to `skillMDFrontmatter`
2. Adding `parseSkillDocumentFull` that returns raw frontmatter + body alongside ProjectSkill
3. Update path now applies changes to the frontmatter struct directly and writes via `buildSkillMDFromFrontmatter` (preserves all fields)
4. Reorder path uses the same pattern — only modifies position in the parsed frontmatter

### DEFERRED: Concurrent edit/reorder clobbers (CRITICAL)
Stale read-modify-write without optimistic concurrency. Valid concern but:
- Same pattern as the old DB-first service — not a regression
- Single-user tool — concurrent skill editing on the same project is extremely unlikely
- Proper fix (OCC with etag/version) is orthogonal to the migration
- Logged for future work

### DEFERRED: Frontend still uses `enabled` (HIGH)
Backend correctly removes a dead field. Frontend-v2 is the active frontend work. Old frontend degrades gracefully (toggle becomes no-op, doesn't crash). Frontend followup expected.

## Verification Results
- `go build ./...` — clean
- `go vet ./...` — clean
- 61 tests pass (handler: 34, agents: 27)
- New file_project_skill.go has no direct unit tests yet (file resolver tests cover read path)
