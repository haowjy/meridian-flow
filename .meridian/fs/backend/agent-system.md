# Agent System

File-backed persona and skill resolution, git import pipeline, and legacy backfill. All runtime agent data lives in `.agents/` within the project's document tree — no DB fallback for resolution.

## Package Layout

| Package | Role |
|---------|------|
| `backend/internal/domain/agents/` | Domain types (`Persona`, `RuntimeSkill`, `ValidationIssue`) and service interfaces |
| `backend/internal/service/agents/` | File-backed implementations of all interfaces |
| `backend/internal/pkg/frontmatter/` | Generic YAML frontmatter parser (zero domain imports) |
| `backend/internal/app/domains/agents.go` | Agent module wiring (import + persona handlers) |
| `backend/internal/app/domains/skill.go` | Skill module wiring (resolver + backfill handler) |
| `backend/internal/capabilities/registry.go` | Model/provider capability registry (embedded YAML) |

## Resolution Flow

```mermaid
flowchart TD
    subgraph request ["Incoming Request"]
        spawn["Agent spawn / skill invoke"]
    end

    subgraph catalog ["PersonaCatalog / SkillResolver"]
        resolve["Resolve by slug"]
        list["List with filters"]
    end

    subgraph doctree [".agents/ Document Tree"]
        persona_file[".agents/agents/slug.md"]
        skill_file[".agents/skills/slug/SKILL.md"]
    end

    subgraph parsing ["Frontmatter Parser"]
        split["split: delimiter scan"]
        yaml["yaml.Unmarshal"]
        typed["ParseInto generic"]
    end

    subgraph validation ["Validation"]
        required["Required field check"]
        model_check["Model capability check"]
        bool_default["UserInvocable nil filter"]
    end

    spawn --> resolve
    spawn --> list
    resolve --> persona_file
    resolve --> skill_file
    persona_file --> typed
    skill_file --> typed
    typed --> split
    split --> yaml
    yaml --> required
    required --> model_check
    model_check --> bool_default
    bool_default --> spawn

    list --> persona_file
    list --> skill_file
```

## Persona Model

**Domain type:** `Persona` at `domain/agents/types.go:9-57`

A persona is an agent profile loaded from `.agents/agents/<slug>.md`. The slug is derived from the filename, not frontmatter — runtime identity is path-stable.

**Key fields and why:**

| Field | Type | Why |
|-------|------|-----|
| `Slug` | `string` | Derived from filename at load time. Path-stable identity. |
| `Model` / `Provider` | `string` | Explicit model routing override. Empty = inherit caller context. |
| `Tools` / `DisallowedTools` | `[]string` | Allowlist/denylist composition. `nil` Tools = inherit all; empty slice = none. |
| `Skills` | `[]string` | Complete startup skill set. **Non-inheriting** — prevents accidental privilege bleed from parent context. |
| `UserInvocable` | `*bool` | Pointer so YAML omission (nil) is distinct from explicit `false`. Nil → default true via `BoolDefaultTrue`. |
| `DisableModelInvocation` | `bool` | Hard switch for spawn eligibility. Plain bool is fine here — default is `false`, which matches Go zero value. |
| `SystemPrompt` | `string` | Markdown body after frontmatter. Not serialized (`json:"-"`). |
| `SourcePath` | `string` | Provenance/debugging. E.g. `.agents/agents/writing-coach.md`. |

### PersonaCatalog

**Interface:** `domain/agents/interfaces.go:28-42` → **Impl:** `filePersonaCatalog` at `service/agents/persona_catalog.go:26-34`

**Resolve vs List behavioral split:**

| Operation | Invalid model | Invalid frontmatter |
|-----------|--------------|-------------------|
| `ResolvePersona` | Hard fail (`PersonaInvalid`) | Hard fail (`PersonaInvalid`) |
| `ListUserPersonas` | Soft fail (issue logged, persona kept) | Excluded from results, added to issues |
| `ListSpawnablePersonas` | Same soft fail | Same exclusion |

**Why the split:** Resolve is called at execution time — an unrunnable persona must not proceed. List is called for catalog display — hiding a persona with a bad model makes it invisible and undiagnosable. The issue list gives callers the data to surface warnings.

**Model validation** (`persona_catalog.go:227-248`): Delegates to `capabilities.Registry`. When provider is set, checks that exact provider. When omitted, iterates all configured providers and accepts the first match. Skipped entirely when registry is nil or model is empty.

**N+1 access pattern** (`persona_catalog.go:22-25`): `ListByFolder` returns metadata only, so `GetByID` is called per document. Acceptable because persona catalogs are small (<~20) and only loaded at spawn time.

**Missing folder = empty, not error** (`persona_catalog.go:136-142`): A project with no `.agents/agents/` folder simply has no personas.

## Skill Model

**Domain type:** `RuntimeSkill` at `domain/agents/types.go:59-100`

A skill is loaded from `.agents/skills/<slug>/SKILL.md`. The directory-per-skill layout enables future co-located assets.

**Key fields and why:**

| Field | Type | Why |
|-------|------|-----|
| `UserInvocable` | `*bool` | Whether skill appears in user `/skill` commands. Nil → true. Matches Claude Code skill spec field `user-invocable`. |
| `DisableModelInvocation` | `bool` | Whether prompt injection and `skill_invoke` are blocked. Plain bool — Go zero value (`false`) matches spec default (model invocation allowed). Matches Claude Code skill spec field `disable-model-invocation`. |
| `Source` | `string` | Always `"file"` — provenance marker for downstream consumers. |

**Spec alignment note:** Fields follow the [Claude Code skill spec](https://code.claude.com/docs/en/skills). `disable-model-invocation` uses negated naming so Go's zero value is the correct default. `user-invocable` defaults to true in the spec, requiring `*bool` so nil (YAML omission) is distinguishable from explicit `false`. The previous `Enabled` and `ModelInvocable` fields were removed — `Enabled` doesn't exist in the spec, and `ModelInvocable` was renamed to match the spec's `disable-model-invocation`.

### SkillResolver

**Interface:** `domain/agents/interfaces.go:9-26` → **Impl:** `fileSkillResolver` at `service/agents/skill_resolver.go:38-45`

Resolution: Loads `.agents/skills/<slug>/SKILL.md` by exact path. Not found → `SkillNotFound`. Invalid → `SkillInvalid`. No silent fallback.

List: Enumerates child folders under `.agents/skills/` with `IncludeHidden: true` (backfill creates hidden folders). Deduplicates by slug. Missing `SKILL.md` in a folder → validation issue, not error.

**Separate frontmatter struct** (`skill_resolver.go:20-32`): `skillFrontmatter` exists because `RuntimeSkill` uses JSON-style tags (`user_invocable`) while SKILL.md spec mandates hyphenated YAML keys (`user-invocable`). The read-side struct maps between them.

## BoolDefaultTrue Pattern

**Definition:** `domain/agents/types.go`

```go
func BoolDefaultTrue(b *bool) bool {
    if b == nil { return true }
    return *b
}
```

**Why this exists:** Go's zero value for `bool` is `false`. When YAML omits a field, the struct gets `false` — silently inverting intended defaults. Using `*bool` makes omission (nil) distinguishable from explicit `false`.

**Only used for `UserInvocable`** on both `Persona` and `RuntimeSkill`. Other boolean fields use the spec's negated naming pattern (`disable-model-invocation`) where Go's zero value matches the correct default, avoiding the need for pointers.

**Why not rename `user-invocable`?** The [Claude Code skill spec](https://code.claude.com/docs/en/skills) mandates the field name `user-invocable` with default `true`. We can't rename it to `disable-user-invocation` without breaking spec compliance.

## Frontmatter Parser

**Location:** `backend/internal/pkg/frontmatter/parser.go` — pure utility, zero domain imports.

**Public API:**
- `Parse(content) → map[string]interface{}, body, error` — untyped extraction
- `ParseInto[T](content) → T, body, error` — generic typed unmarshaling

Both delegate to `split()` for delimiter mechanics, then YAML unmarshal.

**Delimiter rules** (`parser.go:63-113`):
- Opening must be exactly `---\n` as the first line
- Closing must be exactly `---` on its own line (`\n---\n` or `\n---` at EOF)
- Lines like `--- note` are explicitly skipped as false positives (iterative scan)
- CRLF normalized to LF before scanning
- One conventional newline after closing delimiter is stripped

**Forward compatibility:** Unknown YAML fields silently ignored (`parser.go:26-27, 45-46`) so external bundles with extra metadata don't break.

**Why exact delimiter matching:** Naive `\n---` matching incorrectly accepted prefixed delimiter text. Fixed after review finding (session c39 segment 9).

## Git Import Pipeline

### GitFetcher

**Interface:** `domain/agents/interfaces.go:62-74` → **Impl:** `gitFetcher` at `service/agents/git_fetcher.go:36-44`

**Validation** (`git_fetcher.go:57-71`):
1. Parse URL
2. Require `https` scheme (rejects `git://`, `ssh://`, `file://`)
3. Require host in allowlist: `github.com`, `gitlab.com`, `bitbucket.org`

**Clone** (`git_fetcher.go:78-124`):
1. Re-validate URL
2. `git clone --depth=1` with 60s timeout
3. `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` — prevent credential prompt hangs
4. On failure: clean temp dir, return sanitized error **without** stderr (credential leak prevention)
5. Measure total repo size, enforce 50 MB cap

**`sanitizeURL`** (`git_fetcher.go:129-136`): Strips `userinfo` from URLs before logging to prevent `https://user:token@host/...` leaking into log output.

### ImportService

**Interface:** `domain/agents/interfaces.go:44-51` → **Impl:** `agentImportService` at `service/agents/import_service.go:31-40`

**Pipeline** (`import_service.go:77-139`):

```mermaid
flowchart LR
    A["1. ValidateURL<br/>HTTPS + allowlist"] --> B["2. Clone<br/>depth=1, 60s timeout"]
    B --> C["3. Walk .agents/<br/>collectFiles"]
    C --> D["4. ExecTx<br/>atomic upsert all"]
```

**File validation in `collectFiles`** (`import_service.go:144-210`):

| Check | Why |
|-------|-----|
| Reject symlinks | Prevent path escape and content masking |
| Per-file size cap (1 MB) before read | Avoid OOM on large files |
| Null-byte detection | Reject binary content |
| Frontmatter validation for `.md` | Runtime loaders will reject without it — fail early |
| Path separator normalization | Windows safety |

**Write semantics:**
- **Always-overwrite** for files present in bundle; absent files left untouched
- **Atomic** via `ExecTx` — any failure rolls back everything
- Folder hierarchy ensured under `.agents` only (`ensureFolderHierarchy` guards path prefix at `import_service.go:300-303`)
- `.agents` root created as system folder; descendants as hidden folders

### Security Layers

```mermaid
flowchart TD
    subgraph network ["Network Controls"]
        ssrf["HTTPS + host allowlist<br/>git_fetcher.go:27-34, 57-71"]
        noninteractive["Non-interactive clone<br/>GIT_TERMINAL_PROMPT=0"]
        timeout["60s clone timeout"]
    end

    subgraph size ["Size Controls"]
        repo_cap["Repo: 50 MB total<br/>git_fetcher.go:17-20"]
        file_cap["File: 1 MB each<br/>git_fetcher.go:22-24"]
    end

    subgraph content ["Content Controls"]
        symlink["Symlink rejection<br/>import_service.go:152-158"]
        binary["Binary rejection<br/>import_service.go:176-182"]
        frontmatter_check["Frontmatter validation<br/>import_service.go:186-195"]
    end

    subgraph path ["Path Controls"]
        agents_guard[".agents prefix guard<br/>import_service.go:300-303"]
        sanitize["URL sanitization for logs<br/>git_fetcher.go:129-136"]
        stderr_suppress["Stderr suppression<br/>git_fetcher.go:104-109"]
    end

    network --> size --> content --> path
```

## Backfill Service

**Interface:** `domain/agents/interfaces.go:53-60` → **Impl:** `backfillService` at `service/agents/backfill.go:86-94`

Migrates legacy `project_skills` DB rows to `.agents/skills/<slug>/SKILL.md` files.

**Pipeline** (`backfill.go:114-215`):
1. Load all legacy skills from DB
2. Ensure `.agents/` and `.agents/skills/` folders
3. For each skill: check if SKILL.md exists (idempotency guard) → ensure per-skill folder → build content → create document
4. Aggregate per-skill failures; return combined error after full loop

**Content generation** (`buildSkillMDContent`, `backfill.go:42-81`): Emits frontmatter + body. Omits default fields to keep files minimal — only writes `user-invocable: false` or `disable-model-invocation: true` when they differ from defaults.

**Design choice — idempotent, not reconciling:** Backfill only creates missing files; never updates or deletes existing ones. Retry-safe with minimal risk. Orphan prevention is delegated to the skill CRUD delete path (`service/skill/project_skill.go:166-205`), which cleans up both `SKILL.md` and the parent folder.

## Module Wiring

Two separate modules wire the agent subsystem in `internal/app/domains/`:

**AgentModule** (`agents.go`): Owns `GitFetcher` → `ImportService` → `ImportHandler`. Also optionally wires `PersonaHandler` when `PersonaCatalog` is provided.
- Route: `POST /api/projects/{id}/agents/import-git`
- Route: `GET /api/projects/{id}/agents` (persona list, conditional)

**SkillModule** (`skill.go`): Owns `SkillResolver` + `BackfillService` + `BackfillHandler`.
- Route: `POST /api/projects/{id}/agents/backfill`
- Plus standard skill CRUD routes

**Bootstrap wiring** (`bootstrap.go:86-93`): `PersonaCatalog` is constructed once with the shared document/folder repos and capability registry, then injected into both `LLMModule` (for streaming pipeline persona resolution) and `AgentModule` (for the HTTP list endpoint).

```mermaid
flowchart TD
    bootstrap["bootstrap.go"]

    bootstrap --> persona_cat["NewFilePersonaCatalog<br/>docRepo + folderRepo + capRegistry"]
    bootstrap --> agent_mod["AgentModule<br/>agents.go"]
    bootstrap --> skill_mod["SkillModule<br/>skill.go"]
    bootstrap --> llm_mod["LLMModule"]

    persona_cat --> agent_mod
    persona_cat --> llm_mod

    skill_mod --> resolver["NewFileSkillResolver"]
    skill_mod --> backfill["NewBackfillService"]

    resolver --> llm_mod

    agent_mod --> fetcher["NewGitFetcher"]
    agent_mod --> import_svc["NewAgentImportService"]
    fetcher --> import_svc
```

## Interface → Implementation Map

| Interface | Location | Implementation | Location |
|-----------|----------|---------------|----------|
| `SkillResolver` | `interfaces.go:17-26` | `fileSkillResolver` | `skill_resolver.go:38-45` |
| `PersonaCatalog` | `interfaces.go:28-42` | `filePersonaCatalog` | `persona_catalog.go:26-34` |
| `AgentImportService` | `interfaces.go:44-51` | `agentImportService` | `import_service.go:31-40` |
| `BackfillService` | `interfaces.go:53-60` | `backfillService` | `backfill.go:86-94` |
| `GitFetcher` | `interfaces.go:62-74` | `gitFetcher` | `git_fetcher.go:36-44` |

All paths relative to `backend/internal/domain/agents/` (interfaces) and `backend/internal/service/agents/` (implementations). Each has a compile-time `var _ Interface = (*impl)(nil)` assertion.

## Key Design Decisions

| Decision | Rationale | Evidence |
|----------|-----------|----------|
| File-first runtime source of truth | Eliminates DB/runtime divergence; makes agent bundles portable across projects | Interface comments, session c39 |
| `*bool` for default-true policy fields | Go zero-value `false` silently inverts intended defaults when YAML omits field | `types.go:67-70`, fix in session c39 |
| Strict resolve / permissive list | Hard fail at execution time; keep catalog visible while surfacing issues | `persona_catalog.go:80-88` vs `:194-211` |
| Layered import validation before writes | Reject risky bundles early; keep document writes atomic | `git_fetcher.go` + `import_service.go` |
| Backfill idempotency over reconciliation | Retry-safe migration with minimal risk | `backfill.go:146-155` skip-on-existing |
| Separate read/write frontmatter structs | JSON tags (underscores) vs YAML spec (hyphens) can't coexist on one struct | `skill_resolver.go:20-32` vs `backfill.go:26-33` |
