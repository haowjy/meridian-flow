# domains/preferences — project preferences

Manages per-project user preferences (thread grouping, pinned threads, default
agent, auto-resume settings, and current Work). Copy-on-write merge semantics
keep in-memory and Drizzle adapters behaviorally identical.

## What it owns

- **`ProjectPreferencesRepository` port** — `read` / `upsert` with
  `defaultProjectPreferences()` fallback, plus current-Work get/set and
  compare-and-swap (`setCurrentWorkIdIfUnchanged`).
- **Domain helpers** — `copyProjectPreferences` (defensive copy),
  `mergeProjectPreferences` (patch application),
  `defaultProjectPreferences` (canonical defaults).
- **Contract types** — `ProjectPreferences`, `UpdateProjectPreferencesRequest`
  from `@meridian/contracts/preferences`.

## Ports

| Port | Surface |
|---|---|
| `ProjectPreferencesRepository` | Reads/upserts UI preferences and gets/sets the writer’s current Work for one project; compare-and-swap protects fallback repair from overwriting a concurrent selection. |

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
- **Current Work is an identity, not UI state.** It stays on the same
  `(userId, projectId)` row, and archive does not clear it. A resolver may
  repair only a null or dangling value; that write is compare-and-swap against
  the value it read, then retries on contention.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — orchestrator reads preferences for agent
  selection and auto-resume behavior.
- **Depends on `@meridian/contracts/preferences`** — `ProjectPreferences` type
  and defaults.
