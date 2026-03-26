# Phase SM: Skill Migration (File-Only After Backfill)

## Scope
Create a backfill service that migrates DB skills to files, switch all runtime paths to use SkillResolver (file-only), and make legacy CRUD write to files directly.

## Dependencies
- A3b (SkillResolver implementation)

## Files to Create
- `backend/internal/service/agents/backfill.go` — admin backfill: reads DB skills, writes to .agents/skills/<slug>/SKILL.md
- `backend/internal/handler/agent_admin.go` — POST /api/projects/{id}/agents/backfill endpoint

## Files to Modify
- `backend/internal/service/skill/project_skill.go` — legacy CRUD now writes to files instead of DB
- `backend/internal/service/llm/tools/skill_invoke.go` — switch to SkillResolver for runtime resolution
- `backend/internal/service/llm/tools/builder.go` — accept SkillResolver for runtime skills
- `backend/internal/service/llm/streaming/system_prompt_resolver.go` — switch loadSkills to SkillResolver

## Key Details
- Backfill reads all project_skills rows, writes SKILL.md files via DocumentRepository
- Backfill is idempotent (safe to re-run)
- Legacy CRUD (create/update/delete skill) writes to files directly — one write path
- Runtime paths (skill_invoke, skill_list, prompt injection) read through SkillResolver
- No shadow file refresh, no dual-read bridge

## Verification Criteria
- [ ] `make test` passes
- [ ] Backfill endpoint creates files for all legacy skills
- [ ] Backfill is idempotent
- [ ] skill_invoke resolves file-backed skill
- [ ] Legacy create/update/delete operates on files
- [ ] Existing skill tests still pass
- [ ] `go vet ./...` clean
