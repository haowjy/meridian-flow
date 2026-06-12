# domains/packages — Installed package → agent/skill catalog

Parses Mars-format package directories on disk, syncs them into a
project workspace-scoped repository, and resolves agent skills across merge layers. A
"package" is a directory with a `mars.toml` manifest plus
markdown-frontmatter agent/skill definitions. Runtime consumes the resolved
catalog through scoped skill registrations: an agent thread resolves skills from
`PackageRepository.getAgentWithLinkedSkills()`, and the runtime's
`skill-tool-factory.ts` late-registers per-skill executable tools.

## What it owns

**Key types** (all in `domain/types.ts`):

| Type | What it is |
|---|---|
| `PackageInstallRecord` | A row tracking that a Mars package has been installed into a project workspace. Keyed by `(project workspaceId, packageName)`. |
| `AgentDefinitionRecord` | A persisted agent — slug, body, YAML-frontmatter meta, config overlays, `sourceType` (`builtin`/`package`/`user`), optional `packageInstallId` FK. `project workspaceId` is nullable for builtins. `enabled` gates visibility. |
| `SkillRecord` | A persisted skill — same shape as agent, plus bundled `files`; invocation flags are read from meta and resolution output. |
| `UserInstalledSkillRecord` | User-scoped skill (no project workspace/package FK). |
| `AgentSkillLinkRecord` | Join link between agent and skill: `loadingMode` (`preloaded`/`available`), ordinal, invocability override flags. |
| `ResolvedPackageContext` | Output of `resolveAgentSkills()`: matched agent + ordered `ResolvedSkill[]` with layer, loading mode, and invocability flags. |

**Modules** (all in `domain/`):

| File | Responsibility |
|---|---|
| `mars-source.ts` | Format owner. Parses `mars.toml` via `smol-toml`, loads `agents/*.md` and `skills/*/SKILL.md` with YAML frontmatter into `ParsedMarsPackageSource`. Normalizes kebab-case keys. Computes `definitionContentChecksum` (sha256 of markdown body + files). Serializes back via `serializeMarkdownDefinition`. |
| `package-sync.ts` | Import/update pipeline. `importLocalMarsPackage()` resolves a local-path dependency graph (recursive, cycle-safe via `seen` set), then writes everything in one transaction: `PackageInstallRecord`, skill/agent rows, agent-skill links. `updateLocalMarsPackage()` reconciles upstream changes — auto-updates pristine items (checksum match), skips locally edited unless `forceReset`, preserves subagent DAGs pruned upstream. |
| `package-export.ts` | Inverse of sync. Reads installed package from repository → `ExportedMarsDirectory` (file map). `writeExportedMarsDirectory()` writes to disk. |
| `resolution.ts` | Skill merge algorithm. `resolveAgentSkills()` merges builtins, user-installed skills, project workspace/global skills, and agent-linked skills. Last writer wins by slug. Sorts by meta type ordinal: principle (0) → guardrail (1) → reference (2). |
| `helpers.ts` | Defensive JSON-shape accessors, `sha256`, `sortedEntries`, `isNodeError`. |

## Contracts (ports)

| Port | Verbs |
|---|---|
| `PackageRepository` | `findPackageInstall(project workspaceId, name)` / `transaction<T>(fn)` / `getAgentWithLinkedSkills(project workspaceId, userId, slug)` |
| `PackageWriteTransaction` | CRUD methods for packages, agents, skills, user-installed skills, plus `linkAgentSkill`, `replaceAgentSkillLinks`, `listAgentSkillLinks` |

`PackageRepository.getAgentWithLinkedSkills` delegates to
`resolveAgentSkills()` inside a fresh transaction. Errors propagate as throws,
not a `Result` type.

## Adapters

| Adapter | File | Used when | Key behaviour |
|---|---|---|---|
| `DrizzlePackageStore` | `adapters/drizzle-package-store.ts` | Production (`createProductionAppPorts`) | Implements all `PackageWriteTransaction` methods via Drizzle. Denormalizes meta fields (`name`, `description`, `type`, `modelInvocable`, etc.) into queryable schema columns on create/update. `getAgentWithLinkedSkills` opens a new `db.transaction`. |
| `InMemoryPackageStore` | `adapters/in-memory-package-store.ts` | Dev + tests (`createInMemoryAppServices`) | Hermetic `Map[]` state. `transaction` clones state, runs callback, commits on success. Exposes `dump()` for test assertions. Seeds via `InMemoryPackageStoreSeed`. |

No env-var selection — production always uses Drizzle, dev/test always uses
in-memory. Unlike the storage domain, there is no `PACKAGE_STORE_PROVIDER`.

## Wiring and runtime consumption

`lib/compose.ts` wires `packageRepository` into `AppServices` and passes it to:

- `createEnsureSkillToolRegistration()` in `domains/runtime/tools/skill-tool-factory.ts`
- `createChildRunCoordinator()` for spawn authorization against caller agent metadata
- core tool wiring that needs package-aware skill execution
- the default package seeder (`seedDefaultPackagesForProject workspace`)

Skill tool registrations are scoped and lazy: `context-builder.ts` resolves the
current agent's skills, ensures each skill tool is registered, and advertises
only the tools available to that agent turn. Skill slugs that collide with
non-skill tools are blocked by the runtime registry policy and recorded as a
`skill_tool.name_collision` event.

## Invariants

- **Agents declare their own resources.** An agent definition carries an explicit
  skill list (via `agent_skills` links) and subagent references. If installed
  independently into a fresh project workspace, it gets exactly the skills and subagents
  it declared — plus the shared builtin/global layer. It never implicitly
  inherits arbitrary project workspace skills.
- **`(project workspaceId, slug)` is unique for agents and skills.** Builtins use
  `project workspaceId IS NULL` uniqueness. Slug collision during import causes a skip
  (recorded in `skippedAgents`/`skippedSkills`), not an overwrite.
- **Pristine detection via checksum.** `originalContentChecksum` vs.
  recomputed `definitionContentChecksum`. Locally edited records (mismatch) are
  skipped during `updateLocalMarsPackage` unless `forceReset=true`.
- **Preserved subagent DAG.** When an upstream update removes agents that a
  locally edited agent references as subagents, the entire referenced subagent
  DAG is preserved (recursive walk). Same for skills referenced by skipped agents.
- **Import is transactional.** `importLocalMarsPackage` runs all writes inside
  a single `repository.transaction`. On failure, nothing is persisted.
- **Local-dependency-only.** `resolvePackageGraph` only follows `[dependencies]`
  entries with a `path` (local filesystem). Remote `url` dependencies are collected
  as `unsupportedDependencies` and returned in `PackageImportResult.skippedDependencies`.
- **No throw-free boundary.** Unlike the storage domain's `ObjectStoreResult<T>`,
  errors propagate as raw throws. Callers must catch.
- **`sourcePath` is not serialized in export.** `exportMarsPackage` reconstructs
  only `mars.toml`, agent markdown, and skill markdown. The `sourcePath` from
  `PackageInstallRecord` is metadata only.
