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

- **In-memory** (production) — `Map`-backed store. Exported as the production
  surface.
- **Drizzle** (reference, not exported) — persists to a `workbench_preferences`
  table. Kept in-tree as upstream parity reference code but intentionally not
  re-exported from the barrel (`index.ts`) because the required table does not
  exist in the Meridian Flow schema.

## Decision: in-memory only in production

Meridian Flow does not currently persist copied Voluma workbench preferences in
the app schema. The production surface (`createInMemoryWorkbenchPreferencesRepository`)
uses an in-memory `Map`. The Drizzle adapter (`createDrizzleWorkbenchPreferencesRepository`)
remains in-tree at `adapters/drizzle/` as upstream parity reference code but is
not re-exported — importing it would fail at runtime because the
`workbench_preferences` table does not exist.

Preferences are therefore ephemeral (lost on server restart). This is acceptable
for the current dev phase; persistence can be added later by either adopting the
table or mapping preferences into an existing table.

## Invariants

- **Copy-on-write.** `mergeWorkbenchPreferences` always returns a new object;
  default arrays (`pinnedThreadIds`) are copied, not shared.
- **Patch semantics.** Nullable fields (`autoResume`) can be set to `undefined`
  via `UpdateWorkbenchPreferencesRequest`.
- **No persistence.** Not durable across server restarts.

## Cross-domain dependencies

- **Consumed by `domains/runtime`** — orchestrator reads preferences for agent
  selection and auto-resume behavior.
- **Depends on `@meridian/contracts/preferences`** — `WorkbenchPreferences` type
  and defaults.
