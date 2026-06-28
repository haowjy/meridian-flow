# domains/preferences — project preferences

Manages per-project user preferences (thread grouping, pinned threads, default
agent, auto-resume settings, AI write mode). Copy-on-write merge semantics keep in-memory and
Drizzle adapters behaviorally identical.

## What it owns

- **`ProjectPreferencesRepository` port** — `get` / `set` with
  `defaultProjectPreferences()` fallback.
- **Domain helpers** — `copyProjectPreferences` (defensive copy),
  `mergeProjectPreferences` (patch application),
  `defaultProjectPreferences` (canonical defaults).
- **Contract types** — `ProjectPreferences`, `UpdateProjectPreferencesRequest`
  from `@meridian/contracts/preferences`.

## Ports

| Port | Surface |
|---|---|
| `ProjectPreferencesRepository` | `get(projectId)` → `ProjectPreferences`, `set(projectId, patch)` → `ProjectPreferences` |

## Adapters

- **Drizzle** (production) — persists to `project_user_preferences` and is
  wired in the server composition root.
- **In-memory** (test/local reference) — `Map`-backed store used by fast
  conformance coverage and isolated callers.

## Decision: persisted production preferences

Project preferences are durable in the app schema via
`project_user_preferences`. The production surface uses
`createDrizzleProjectPreferencesRepository`; the in-memory adapter remains for
hermetic tests and local reference behavior.

## Invariants

- **Copy-on-write.** `mergeProjectPreferences` always returns a new object;
  default arrays (`pinnedThreadIds`) are copied, not shared.
- **Patch semantics.** Nullable fields (`autoResume`) can be set to `undefined`
  via `UpdateProjectPreferencesRequest`.
- **Persistence.** Production preferences survive server restart through Drizzle/Postgres.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — orchestrator reads preferences for agent
  selection and auto-resume behavior.
- **Depends on `@meridian/contracts/preferences`** — `ProjectPreferences` type
  and defaults.
