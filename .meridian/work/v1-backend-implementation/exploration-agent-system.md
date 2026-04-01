# Agent System Exploration (Personas, Skills, Import, Backfill, Frontmatter)

Scope explored in full:
- `backend/internal/domain/agents/*`
- `backend/internal/service/agents/*`
- `backend/internal/pkg/frontmatter/*`

Supporting context (for wiring/rationale):
- `backend/internal/capabilities/registry.go`
- `backend/internal/app/domains/{agents,skill}.go`
- `backend/internal/app/bootstrap.go`
- parent session `c39` (compaction context for historical decisions)

## 1) Persona System

### What a Persona is
`Persona` is the runtime representation of an agent profile loaded from `.agents/agents/<slug>.md` (`backend/internal/domain/agents/types.go:6-57`).

Key fields and why they exist:
- `Slug` (`types.go:10-13`): canonical identity derived from filename, not frontmatter, so runtime identity is path-stable.
- `Name`, `Description` (`types.go:15-16`): required metadata for display and selection.
- `Model`, `Provider` (`types.go:18-20`): explicit model routing override; empty model means inherit caller context.
- `Tools`, `DisallowedTools` (`types.go:22-27`): allowlist/denylist composition for tool permissions.
- `Skills` (`types.go:28-30`): explicit startup skill set, intentionally non-inheriting to avoid accidental privilege bleed.
- Sampling/runtime controls (`Temperature`, `MaxTokens`, `MaxTurns`, `Background`, `Effort`) (`types.go:32-40`): execution-shaping controls.
- `UserInvocable *bool` (`types.go:42-46`): pointer used so YAML omission is distinct from explicit false; omission maps to default true via `BoolDefaultTrue`.
- `DisableModelInvocation bool` (`types.go:46-49`): hard switch for spawn eligibility.
- `SystemPrompt` (`types.go:50-53`): markdown body after frontmatter.
- `SourcePath` (`types.go:54-57`): provenance/debugging path in doc tree.

### PersonaCatalog organization
Contract: `domainagents.PersonaCatalog` in `interfaces.go:28-42`.
Implementation: `filePersonaCatalog` in `service/agents/persona_catalog.go:26-31`, with compile-time assertion (`:34`).

Organization pattern:
- `ResolvePersona` (`persona_catalog.go:58-91`): strict path load + parse + model validation; returns `PersonaNotFound`/`PersonaInvalid` domain errors.
- `ListUserPersonas` (`:98-111`): list all valid personas then filter with `BoolDefaultTrue(UserInvocable)`.
- `ListSpawnablePersonas` (`:118-131`): list all valid personas then filter on `!DisableModelInvocation`.
- `listAll` (`:135-217`): shared enumeration + issue collection; invalid entries become `ValidationIssue` and are excluded.

Important structural behavior:
- Folder-missing is non-error and returns empty (`:136-142`).
- `ListByFolder` is metadata-only, so implementation intentionally does N+1 `GetByID` for full content (`:22-25`, `:146-167`).
- Non-markdown files are ignored (`:157-160`).

### Model validation via CapabilityRegistry
Validation entrypoint: `validatePersonaModel` (`persona_catalog.go:227-248`).

Mechanics:
- Skips when registry is nil or model omitted (`:228-230`).
- Provider-set path: checks exact provider via `GetModelCapabilities` (`:232-237`).
- Provider-omitted path: iterates all providers from `GetAllProviders` and accepts first match (`:240-247`).

Registry behavior from `capabilities/registry.go`:
- Providers are loaded from embedded YAML (`registry.go:11-36`).
- `GetModelCapabilities` resolves model candidates and returns unknown provider/model errors (`:59-80`).
- `GetAllProviders` returns map keys (unordered) (`:109-118`).

Design choice in PersonaCatalog:
- Resolve path is hard-fail for invalid model (`persona_catalog.go:80-88`).
- List path is soft-fail (issue logged/returned, persona still listed) (`:194-211`).
This matches tests in `persona_catalog_test.go:481-525`.

### BoolDefaultTrue pattern and why
Definition: `BoolDefaultTrue(*bool) bool` (`types.go:102-114`).

Why:
- YAML omission should preserve default-true semantics.
- Plain `bool` cannot distinguish omitted from explicit false in Go.
- Pattern is used by persona/skill filters to prevent silent default inversion.

Evidence:
- Integration behavior in catalog filter (`persona_catalog.go:106-107`).
- Unit coverage in `persona_catalog_test.go:531-542`.
- Historical rationale recorded in session c39 segment 9 message 168 (review fix notes): moved default-true booleans to pointers after catching zero-value false regression.

### Interface contract mapping (personas)
- `domainagents.PersonaCatalog` -> implemented by `filePersonaCatalog` (`persona_catalog.go:34`).
- Wired in app bootstrap via `NewFilePersonaCatalog(...)` with capability registry (`app/bootstrap.go:86-93`), then shared into LLM + agent modules (`:95-115`, `:125-131`).

## 2) Skill System

### What a RuntimeSkill is
`RuntimeSkill` is the file-backed runtime view from `.agents/skills/<slug>/SKILL.md` (`types.go:59-100`).

Key fields and why:
- `Slug`, `Name`, `Description` (`types.go:71-75`): identity + UI metadata.
- `Content` (`:76-77`): markdown body for prompt/tool consumption.
- `Enabled`, `UserInvocable`, `ModelInvocable` as `*bool` (`:79-89`): nil-means-true defaults for compatibility and explicit override control.
- `Position`, `Version` (`:90-93`): optional ordering/version hints.
- `Source`, `SourcePath` (`:94-99`): provenance; current source is always file.

### How SkillResolver finds/parses skills
Contract: `domainagents.SkillResolver` (`interfaces.go:9-26`).
Implementation: `fileSkillResolver` (`skill_resolver.go:38-42`, assertion at `:45`).

Resolution flow:
- `Resolve` loads exact path `.agents/skills/<slug>/SKILL.md` and parses into runtime struct (`skill_resolver.go:66-89`).
- Not found -> `SkillNotFound`; parse/validation error -> `SkillInvalid`.

List flow:
- Locates `.agents/skills` folder (`:99-107`); missing folder => empty result.
- Lists child folders with `IncludeHidden: true` (`:109-114`) because backfill may create hidden folders.
- For each slug folder:
  - Missing `SKILL.md` becomes validation issue (`:133-140`).
  - Invalid frontmatter becomes validation issue (`:145-156`).
  - Valid entries appended to result (`:158`).
- Deduplicates slugs using `seen` (`:120-127`).

### SKILL.md frontmatter format
Parsing struct is `skillFrontmatter` (`skill_resolver.go:20-32`) with YAML keys:
- `name` (required)
- `description`
- `enabled`
- `user-invocable`
- `model-invocable`
- `position`
- `version`

`parseSkillDoc` (`skill_resolver.go:167-190`):
- Uses generic `frontmatter.ParseInto[skillFrontmatter]`.
- Enforces required `name` (`:173-175`).
- Maps parsed fields into `RuntimeSkill` with `Source: "file"`.

Design rationale:
- Separate `skillFrontmatter` exists because `RuntimeSkill` tags are JSON-style, while on-disk schema uses hyphenated YAML keys (`skill_resolver.go:20-24`).
- File-only resolution is explicit and no DB fallback is allowed (`skill_resolver.go:34-37`, `interfaces.go:9-16`).

### Interface contract mapping (skills)
- `domainagents.SkillResolver` -> `fileSkillResolver` (`skill_resolver.go:45`).
- Wired in skill module (`app/domains/skill.go:48-53`).
- Consumed downstream by LLM flows/tools (e.g., stream resolver and skill tool; references found via `rg`).

## 3) Git Import System

### GitFetcher behavior
Contract: `domainagents.GitFetcher` (`interfaces.go:62-74`).
Implementation: `gitFetcher` (`git_fetcher.go:36-49`, assertion at `:44`).

`ValidateURL` (`git_fetcher.go:57-71`):
- Parse URL.
- Require `https` scheme.
- Require host in allowlist (`github.com`, `gitlab.com`, `bitbucket.org`) (`:27-34`).

`Clone` (`git_fetcher.go:78-124`):
- Re-validates URL before clone.
- Creates temp dir.
- Uses timeout-bound `git clone --depth=1` (`:88-96`).
- Disables interactive credential prompts (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`) (`:93-99`).
- On clone failure, cleans temp dir and returns sanitized validation error without stderr echo (credential leak prevention) (`:104-109`).
- Measures total repo size and enforces cap (`maxRepoBytes=50MB`) (`:17-25`, `:111-121`).

Utility security helper:
- `sanitizeURL` strips userinfo for safe logging (`git_fetcher.go:126-136`).

### ImportService processing flow
Contract: `domainagents.AgentImportService` (`interfaces.go:44-51`).
Implementation: `agentImportService` (`import_service.go:31-37`, assertion `:40`).

Pipeline in `ImportFromGit` (`import_service.go:77-139`):
1. Fast URL validation (`:78-81`).
2. Clone and defer cleanup (`:83-95`).
3. Require `.agents/` exists (`:98-101`).
4. Collect and validate all files (`collectFiles`, `:103-106`, `:141-210`).
5. If non-empty, atomically upsert all files in single transaction (`:116-131`).

Validation in `collectFiles` (`import_service.go:147-206`):
- Reject symlinks (`:152-158`).
- Enforce per-file size cap (`maxFileBytes=1MB`) before reading (`:164-169`).
- Reject binary files via null-byte detection (`:176-182`).
- For `.md`, require valid frontmatter via parser (`:186-195`).
- Normalize relative path separators (`:198-204`).

Write semantics:
- Always-overwrite for files present in bundle (`:26-28`, `upsertFile` at `:255-281`).
- Atomic all-or-nothing via `ExecTx` (`:29-30`, `:117-128`).
- Folder hierarchy ensured under `.agents` only (`ensureFolderHierarchy` with guard at `:300-303`).
- `.agents` root created as system folder, descendants as hidden (`:286-289`, `:305-333`).

### Security considerations
Present controls:
- SSRF mitigation: HTTPS + strict host allowlist (`git_fetcher.go:38-40`, `:57-69`).
- Non-interactive clone to avoid hanging on auth prompts (`:93-99`).
- Clone timeout (`:88-90`).
- Repo/file size limits (`:17-25`, `:164-169`, `:111-121`).
- Symlink rejection to prevent path escape (`import_service.go:152-158`).
- Binary rejection (`:176-182`).
- Frontmatter validation for markdown (`:186-195`).
- Credential-safe logging via URL sanitization and stderr suppression (`git_fetcher.go:106-109`, `:126-136`; handler-level sanitization in `handler/agent_import.go:100-130`).

Path traversal prevention notes:
- Files are discovered by walking cloned repo `.agents` subtree (`import_service.go:147`), with symlink traversal blocked.
- Folder creation is constrained to paths starting `.agents` (`:300-303`), preventing writes outside namespace.

### Interface contract mapping (import)
- `domainagents.GitFetcher` -> `gitFetcher` (`git_fetcher.go:44`).
- `domainagents.AgentImportService` -> `agentImportService` (`import_service.go:40`).
- Wired in agent module and exposed at `POST /api/projects/{id}/agents/import-git` (`app/domains/agents.go:33-39`, `:67-69`).

## 4) Backfill System

### BackfillService migration behavior
Contract: `domainagents.BackfillService` (`interfaces.go:53-60`).
Implementation: `backfillService` (`backfill.go:86-91`, assertion `:94`).

Primary method `BackfillSkills` (`backfill.go:114-215`):
1. Load legacy skills from DB (`:117-120`).
2. Ensure `.agents` and `.agents/skills` folders (`:127-137`).
3. For each skill:
   - Compute target path `.agents/skills/<slug>/SKILL.md` (`:144`).
   - If file exists, skip (idempotency) (`:146-155`).
   - Ensure per-skill folder (`:163-170`).
   - Build SKILL.md content from DB row (`:172-177`).
   - Create document (`:179-193`).
4. Aggregate per-skill failures and return combined error after loop (`:139-142`, `:210-212`).

Content conversion logic (`buildSkillMDContent`, `backfill.go:35-81`):
- Emits frontmatter + body.
- Omits default-true fields to keep file minimal.
- Maps legacy metadata to `enabled`, `user-invocable`, `model-invocable`, `position`.

### Orphan cleanup logic
Within `backfillService` itself: there is no orphan-folder cleanup pass.
- Behavior is additive and idempotent: create missing file copies, skip existing (`backfill.go:146-155`).

Related cleanup behavior exists in `projectSkillService.deleteSkillFile` (`service/skill/project_skill.go:166-205`):
- Deletes `SKILL.md` and parent `.agents/skills/<slug>` folder to prevent orphan directories causing persistent `SkillResolver.List` validation issues.

So current system split is:
- Backfill: migration-only, no orphan sweep.
- Ongoing CRUD delete path: explicit orphan prevention.

### Interface contract mapping (backfill)
- `domainagents.BackfillService` -> `backfillService` (`backfill.go:94`).
- Wired and exposed at `POST /api/projects/{id}/agents/backfill` (`app/domains/skill.go:52-53`, `:73`).

## 5) Frontmatter Parser

### Generic Parse / ParseInto model
Location: `backend/internal/pkg/frontmatter/parser.go`.

Public APIs:
- `Parse(content)` -> `map[string]interface{}`, `body`, error (`parser.go:30-42`).
- `ParseInto[T](content)` -> typed struct `T`, `body`, error (`:47-61`).

Both delegate delimiter mechanics to `split` (`:63-113`), then YAML-unmarshal raw frontmatter.
Unknown fields are intentionally tolerated for forward compatibility (`:26-27`, `:45-46`).

### Delimiter handling
`split` enforces:
- Opening delimiter must be first line exactly `---\n` (`parser.go:69-72`).
- Closing delimiter must be an exact delimiter line:
  - `\n---\n` (middle)
  - `\n---` at EOF
- It explicitly skips false positives like `--- note` (`:77-96`).

Post-processing:
- Normalizes CRLF to LF (`:66-67`).
- Removes one conventional newline immediately after closing delimiter (`:106-110`).

### Error model
Returns errors for:
- Missing opening delimiter (`parser.go:70-72`).
- Missing closing delimiter (`:97-99`).
- Invalid YAML (`Parse`: `:37-39`; `ParseInto`: `:56-58`).

### Test coverage highlights
`parser_test.go` covers:
- Valid parse, unknown fields, invalid YAML.
- Exact closing-delimiter requirement (`parser_test.go:123-133`).
- Windows line-ending normalization (`:135-150`).
- `ParseInto` typed struct behavior and unknown-field tolerance (`:152-229`).

Design rationale from history:
- Exact delimiter scan was introduced after a review finding that naive `\n---` matching incorrectly accepted prefixed delimiter text (session c39 segment 9 message 168).

## Cross-Cutting Contract Map

- `SkillResolver` interface (`domain/agents/interfaces.go:17-26`) -> `fileSkillResolver` (`service/agents/skill_resolver.go:38-45`)
- `PersonaCatalog` (`interfaces.go:28-42`) -> `filePersonaCatalog` (`service/agents/persona_catalog.go:26-35`)
- `AgentImportService` (`interfaces.go:44-51`) -> `agentImportService` (`service/agents/import_service.go:31-40`)
- `BackfillService` (`interfaces.go:53-60`) -> `backfillService` (`service/agents/backfill.go:86-95`)
- `GitFetcher` (`interfaces.go:62-74`) -> `gitFetcher` (`service/agents/git_fetcher.go:36-45`)

## Key Design Decisions and Rationale (Recovered)

1. File-first runtime source of truth for skills/personas.
- Rationale: remove DB/runtime divergence and make agent bundles portable.
- Evidence: interface/service comments and session c39 summary context.

2. Nil-means-true pointer booleans for default-true policy fields.
- Rationale: avoid Go zero-value false silently overriding intended defaults when YAML omits field.
- Evidence: `types.go:67-70`, `:102-114`, test coverage, and historical fix note in session c39.

3. Split strict resolve vs permissive list behavior.
- Rationale: hard fail when a specific entity is requested for execution; keep catalogs visible while surfacing issues during listing.
- Evidence: persona resolve/list model-validation behavior (`persona_catalog.go:80-88`, `:194-211`).

4. Import safety as layered validation before writes.
- Rationale: reject risky bundles early and keep document writes atomic.
- Evidence: URL + clone controls in `git_fetcher.go`; file validation + transaction in `import_service.go`.

5. Backfill idempotency over destructive reconciliation.
- Rationale: retry-safe migration path with minimal risk.
- Evidence: skip-on-existing and aggregate-error loop in `backfill.go:146-212`.

## Observed Gaps / Constraints

- Explorer delegation via `meridian spawn -a explorer` failed in this environment due read-only filesystem errors under `~/.claude/...`; analysis proceeded via direct source/test reads.
- Backfill service itself has no orphan sweep; orphan prevention is delegated to skill CRUD delete flow (`project_skill.go:166-205`).
- `AgentAdminHandler.BackfillSkills` (`handler/agent_admin.go`) does not perform project authorization checks directly (unlike `AgentImportHandler`); this may rely on upstream middleware/policy.
