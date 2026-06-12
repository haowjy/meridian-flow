# domains/preferences — workbench preferences

Manages per-workbench user preferences (thread grouping, pinned threads, default
agent, auto-resume settings). Copy-on-write merge semantics keep in-memory and
Drizzle adapters behaviorally identical.

## What it owns

- **`WorkbenchPreferencesRepository` port** — `get` / `set` with
  `defaultWorkbenchPreferences()` fallback.
- **Domain helpers** — `copyWorkbenchPreferences` (defensive copy),
  `mergeWorkbenchPreferences` (patch application),
  `defaultWorkbenchPreferences` (canonical defaults).
- **Contract types** — `WorkbenchPreferences`, `UpdateWorkbenchPreferencesRequest`
  from `@meridian/contracts/preferences`.

## Ports

| Port | Surface |
|---|---|
| `WorkbenchPreferencesRepository` | `get(workbenchId)` → `WorkbenchPreferences`, `set(workbenchId, patch)` → `WorkbenchPreferences` |

## Adapters

- **Drizzle** (production) — persists to `workbench_user_preferences` and is
  wired in the server composition root.
- **In-memory** (test/local reference) — `Map`-backed store used by fast
  conformance coverage and isolated callers.

## Decision: persisted production preferences

Workbench preferences are durable in the app schema via
`workbench_user_preferences`. The production surface uses
`createDrizzleWorkbenchPreferencesRepository`; the in-memory adapter remains for
hermetic tests and local reference behavior.

## Invariants

- **Copy-on-write.** `mergeWorkbenchPreferences` always returns a new object;
  default arrays (`pinnedThreadIds`) are copied, not shared.
- **Patch semantics.** Nullable fields (`autoResume`) can be set to `undefined`
  via `UpdateWorkbenchPreferencesRequest`.
- **Persistence.** Production preferences survive server restart through Drizzle/Postgres.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — orchestrator reads preferences for agent
  selection and auto-resume behavior.
- **Depends on `@meridian/contracts/preferences`** — `WorkbenchPreferences` type
  and defaults.
