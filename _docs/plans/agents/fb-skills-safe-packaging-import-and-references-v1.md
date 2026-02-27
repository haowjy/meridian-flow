---
detail: standard
audience: developer
---
# Skills V1.5: Safe Packaging, References UI, and Import

**Status:** In planning  
**Priority:** High  
**Estimated effort:** 3-6 days (full-stack, phased)

## Problem Statement (WHY)

Skills are currently "single blob" records:
- Instructions are stored in DB (`project_skills.content`).
- A hidden folder `/.meridian/skills/<name>/` is created, but there is no user-facing references workflow.
- There is no skill import flow.

This blocks three user needs:
1. Attach reference docs to a skill (examples, schemas, style guides).
2. Import a skill package from outside Meridian.
3. Do both safely without running untrusted code.

Writer-first implication:
- Skills should be reusable and composable, but trust and predictability must stay obvious.
- "Import" must never silently enable risky behavior.

## Current State

### What Works
- Skill CRUD is implemented (`/api/projects/{projectId}/skills`).
- Skill content is DB-backed and invoked via `skill_invoke`.
- Hidden skill folder exists for future references/export (`/.meridian/skills/<name>/`).
- Hidden folders are excluded from normal tree by default.

### What's Missing
- No references UI for skill folders.
- No skill import/export API.
- No package validation policy for skills.
- ~~Legacy comments/paths still mention `.skills/...` in LLM resolver paths, while runtime skills are DB-backed.~~ ✅ Fixed — resolver uses skill service, comments updated.

## Scope and Non-goals

### In Scope (V1.5)
- Define safe skill package contract:
  - Required: `SKILL.md`
  - Optional: `references/**` (text docs only)
- Add skill-scoped references APIs and UI.
- Add skill import flow with strict validation + policy-driven filtering.
- Keep hidden internals hidden from writer doc tree.

### Out of Scope (V1.5)
- Executing scripts shipped in skills.
- Binary assets pipeline (images/fonts/templates).
- Full `.agents/` support (only `.agents/skills/` import is in-scope; other `.agents/` content is deferred).
- Marketplace/public trust model.

## Decision Log (WHY + Extensibility)

| Decision | Why | Extensibility Impact |
|---|---|---|
| Support only `SKILL.md` + `references/**` now | Gives immediate utility with minimal risk | Cleanly add `scripts/`, `assets/`, `agents/` later behind policy |
| Dual-namespace export (`.meridian/skills/` + `.agents/skills/`) | `.meridian/` preserves full Meridian metadata; `.agents/` provides portable format compatible with other AI tools | Import recognizes both; `.meridian/` takes precedence when both exist for same skill |
| Reject/ignore `scripts/` and binaries on import | No trusted code interpreter exists yet | Future policy can allow trusted execution per project/org |
| Use dedicated skill references APIs, not global hidden-tree toggle | Keeps `/.meridian/**` private and avoids accidental leakage in generic flows | Same pattern can power personas/agents later |
| Build import as policy + handler registry | Avoid hardcoded rules scattered across handlers | New component types plug in without rewriting importer |
| Keep skill instructions DB-backed in V1.5 | Fits existing invoke path and minimizes migration risk | Can later support optional file-backed instruction mode if needed |

## Target Skill Package Contract

### V1.5 Contract (accepted by importer)

```text
<package-root>/
  SKILL.md                (required)
  references/             (optional)
    *.md, *.txt, *.json, *.yaml, *.yml, *.csv
```

Rules:
- Exactly one top-level `SKILL.md`.
- `references/**` must be text-like files only (allowlist).
- Path traversal, absolute paths, and hidden/system junk are rejected.
- `scripts/`, `assets/`, `agents/` are unsupported in V1.5.

### Forward-compatible Contract (future)

```text
<package-root>/
  SKILL.md
  references/
  scripts/                (future, gated)
  assets/                 (future, gated)
  agents/                 (future, metadata/config)
```

## Directory Convention: Dual Namespace

### Export (dual output)

Skill export produces both namespaces in the zip:

```text
export.zip/
  .meridian/skills/<name>/
    SKILL.md              # Full content (same as DB)
    metadata.json         # { position, enabled, syncState, disableModelInvocation, userInvocable }
    references/           # Reference docs (if any)
  .agents/skills/<name>/
    SKILL.md              # Portable: YAML frontmatter (name, description) + body
```

- `.meridian/skills/` is the **full-fidelity** format — round-trips all Meridian metadata.
- `.agents/skills/` is the **portable** format — compatible with other AI tools that read `.agents/skills/`.

### Import (recognizes both)

| Source path | Behavior |
|---|---|
| `.meridian/skills/<name>/` | Full metadata restoration via `CreateSkill()` — position, enabled, flags all preserved |
| `.agents/skills/<name>/SKILL.md` | Parse YAML frontmatter for name/description, use defaults for Meridian-specific fields |
| Both exist for same `<name>` | `.meridian/` takes precedence (full fidelity wins) |

### Architecture fit

- `SkillPackagePolicy` gains path-prefix awareness for both namespaces.
- Two `ComponentHandler` implementations:
  - `MeridianSkillHandler` — handles `.meridian/skills/` entries (full metadata).
  - `AgentsSkillHandler` — handles `.agents/skills/` entries (portable, frontmatter parsing).
- `SkillImportService` deduplicates by skill name, preferring `.meridian/` source when both exist.

## Architecture (SOLID and Extensible)

### High-level flow

```mermaid
flowchart LR
  Upload["Upload zip/folder"] --> Parse["Archive Parser"]
  Parse --> Validate["Entry Validator"]
  Validate --> Policy["Package Policy (allow/deny/quarantine)"]
  Policy --> Registry["Component Handler Registry"]
  Registry --> Persist["Skill + References Persistor"]
  Persist --> Report["Import Report (created/skipped/rejected)"]
```

### Core abstractions

1. `SkillPackagePolicy` (DIP/OCP)
- `Decide(entry) -> allow | skip | reject(reason)`
- V1.5 implementation: allow `SKILL.md` + text `references/**`, deny others.

2. `ComponentHandler` registry (OCP/LSP)
- `CanHandle(entry) bool`
- `Handle(ctx, entry, targetSkill) error`
- Initial handlers:
  - `SkillInstructionHandler` (SKILL.md -> `project_skills.content`)
  - `ReferencesHandler` (references/** -> docs under skill folder)

3. `SkillImportService` orchestrator (SRP)
- Coordinates parser -> validator -> policy -> handlers.
- Produces deterministic import report.

4. `SkillValidationService` (ISP)
- Separate from import transport concerns.
- Reused by create/update and import.

### SOLID mapping

- **SRP:** parsing, validation, policy, persistence are separate units.
- **OCP:** new package components added by registering a handler.
- **LSP:** all handlers obey same contract and are swappable.
- **ISP:** APIs split by concern (skill CRUD vs references vs import).
- **DIP:** handlers/services depend on interfaces, not concrete ZIP or storage details.

## API Plan

### References APIs (skill-scoped)

- `GET /api/projects/{projectId}/skills/{skillId}/references`
  - List references tree for the skill.
- `POST /api/projects/{projectId}/skills/{skillId}/references`
  - Create/update a single reference doc.
- `DELETE /api/projects/{projectId}/skills/{skillId}/references/{docId}`
  - Delete a reference doc.
- `POST /api/projects/{projectId}/skills/{skillId}/references/import`
  - Import references bundle (optional shortcut endpoint).

### Import APIs

- `POST /api/projects/{projectId}/skills/import`
  - Accept zip/folder upload.
  - Creates or updates a target skill (explicit mode).
  - Returns import report: created/skipped/rejected with reasons.

- Optional: `POST /api/projects/{projectId}/skills/import/validate`
  - Dry-run validation only (no writes).

## Data and Storage Plan

Keep current model:
- `project_skills.content` remains source of truth for instructions.
- `/.meridian/skills/<skill-name>/references/**` stores reference docs.

No mandatory schema changes for V1.5.

Optional (future-ready) metadata additions:
- `metadata.packageVersion`
- `metadata.importSource`
- `metadata.supportedComponents`

## Security and Validation Plan

### Validation (must-pass)
- Skill name and description rules (existing service validation).
- Skill content max length (new server-side enforcement).
- Package constraints:
  - Max compressed upload size.
  - Max extracted bytes.
  - Max file count.
  - Max path length and nesting depth.
- Reject invalid UTF-8/binary for text-required files.
- Reject `..`, absolute paths, null-byte paths.

### File policy (V1.5)
- Allowed:
  - `SKILL.md`
  - `references/**` text-like extensions
- Rejected:
  - `scripts/**`
  - `assets/**` binary files
  - executables and unknown/binary content
- System/hidden noise (`.git`, `.DS_Store`, `.env*`) skipped or rejected with explicit reason.

## Frontend Plan

### Skill Editor: References Tab
- Add a "References" tab next to instructions editor.
- Capabilities:
  - List references
  - Create/edit markdown reference
  - Upload/import reference bundle
  - Delete reference

### Skill Import UI
- Add "Import Skill" action in skills panel.
- Show validation/import report in UI:
  - imported files
  - skipped files
  - rejected files with reason

### UX policy cues
- Clearly state:
  - "Scripts and assets are not supported yet."
  - "Imported skills cannot execute code in this version."

## Implementation Plan

### Phase 0: Contract + cleanup (0.5 day) ✅ DONE
- Lock V1.5 package contract.
- ✅ Fix legacy `.skills/...` references/comments in resolver/docs to current model.
- ✅ System prompt resolver now uses skill service (DB-backed) instead of document repo.
- ✅ `.agents` namespace reserved alongside `.meridian` (zip import, folder creation, frontend validation).
- Define constants for allowed components and file types.

### Phase 1: Backend validation + import core (1-1.5 days)
- Implement `SkillPackagePolicy` and validator.
- Implement `SkillImportService` + handler registry.
- Add skill content length server validation.
- Add robust import report model.

### Phase 2: References backend APIs (0.5-1 day)
- Implement skill-scoped references endpoints.
- Ensure operations are constrained to skill's instance folder.
- Reuse existing doc services where possible.

### Phase 3: Frontend references UI (0.5-1 day)
- Add references tab in skill editor.
- Wire list/create/edit/delete.
- Add reference import flow + report display.

### Phase 4: Frontend skill import UI (0.5-1 day)
- Add import entrypoint from skills panel.
- Upload zip -> show dry-run/real import report.
- Handle conflict modes (create new vs update existing).

### Phase 5: Hardening + tests + docs (0.5-1 day)
- Unit/integration tests for importer policy, path safety, and limits.
- API contract tests.
- Update feature docs and technical docs.

## Key Files (expected touch points)

- `/Users/jimmyyao/gitrepos/meridian/backend/internal/service/skill/project_skill.go`
- `/Users/jimmyyao/gitrepos/meridian/backend/internal/handler/project_skill.go`
- `/Users/jimmyyao/gitrepos/meridian/backend/internal/domain/services/skill/project_skill.go`
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/skills/components/SkillEditorPanel.tsx`
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/skills/components/SkillListPanel.tsx`
- `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/api.ts`
- `/Users/jimmyyao/gitrepos/meridian/_docs/features/fb-skills/README.md`

## Testing

### Backend
- Package validation:
  - missing SKILL.md -> fail
  - multiple SKILL.md -> fail
  - traversal path -> fail
  - binary in references -> fail
  - scripts/assets present -> rejected with reason
- Import orchestration:
  - create new skill from package
  - import into existing skill
  - partial failures produce deterministic report
- References APIs:
  - only operate within skill folder
  - auth and project scoping verified

### Frontend
- References tab flows:
  - load/list/edit/delete
  - empty/error states
- Import UX:
  - success/partial/rejected report rendering
  - conflict mode handling

### Integration
- End-to-end:
  - import skill package -> invoke skill -> references visible in UI
  - no code execution path exists for imported scripts

## Success Criteria

- [ ] Users can attach and edit references for each skill in UI.
- [ ] Users can import safe skill packages (`SKILL.md` + `references/**`).
- [ ] Unsupported components are blocked/reported (not silently executed).
- [ ] Import behavior is policy-driven and test-covered.
- [ ] Architecture supports adding `scripts/`, `assets/`, and `agents/` via new handlers/policies without rewrites.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Import becomes a generic file-upload attack surface | strict limits, path validation, text/binary checks, extension allowlist |
| Hidden folder leakage into normal doc UX | keep skill-scoped APIs; do not enable global hidden tree in regular flows |
| Future component support causes rewrites | enforce handler registry + policy abstraction from V1.5 |
| Inconsistent skill source-of-truth (DB vs file) | keep DB as instruction source in V1.5; import maps SKILL.md -> DB content explicitly |

## Related Documentation

- `/Users/jimmyyao/gitrepos/meridian/_docs/features/fb-skills/README.md`
- `/Users/jimmyyao/gitrepos/meridian/_docs/plans/agents/fb-artifact-templates-and-project-instances.md`
- `/Users/jimmyyao/gitrepos/meridian/_docs/plans/agents/archive/fb-project-skills-v1-and-artifact-foundations.md`
