# collab — server-side document infrastructure (cutover scaffolding)

The Yjs sync engine, codec, apply, and undo logic have been extracted to
`@meridian/agent-edit` (`packages/agent-edit/`). This domain holds the
server-side residue that hasn't yet been re-homed or replaced.

## Current state (post-extraction, pre-cutover)

| Concern | Location | Status |
|---|---|---|
| Codec (MDX/markdown ↔ PM) | `@meridian/agent-edit` codec layer | Extracted |
| Resolver (block hash, find, scope) | `@meridian/agent-edit` resolver | Extracted |
| 3-tier apply + echo | `@meridian/agent-edit` apply layer | Extracted |
| Hot/cold undo + compaction | `@meridian/agent-edit` undo layer | Extracted |
| Tool surface (`write()`) | `@meridian/agent-edit` tool layer | Extracted |
| Port interfaces (UpdateJournal, etc.) | `@meridian/agent-edit` ports | Extracted |
| Hocuspocus coordinator | `collab/adapters/hocuspocus-coordinator.ts` | Added, not wired |
| mdx-bridge.ts | DELETED (superseded by codec) | — |
| **Throwing stub facade** | `collab/index.ts` | **Temporary** (Step 9 cutover) |
| **UpdateJournal + loader adapters** | `collab/adapters/drizzle-journal.ts`, `document-loader.ts` | Added, not wired |
| **DocumentStore** port + adapters | `collab/ports/`, `collab/adapters/drizzle/`, `collab/adapters/in-memory/` | **Pre-existing**, being superseded |
| **document-activity.ts** | `collab/domain/` | **Stays** (DB-side effects) |

## Stable contracts (still here)

### document-activity.ts

Two DB-side side effects triggered on document write:
- `touchDocumentActivity` — updates `threadDocuments.lastTouchedAt`,
  `works.updatedAt`, `projects.updatedAt`/`lastActivityAt`
- `updateMarkdownProjection` — writes the canonical markdown string to
  `documents.markdownProjection` for read-model access

These stay server-side; they are DB-specific projection effects, not agent-edit
concerns. The Step 9 composition root calls them after each successful write.

### DocumentStore (`ca/ports/document-store.ts`)

Row-level CRUD for Yjs updates, checkpoints, restore points. Being superseded
by `UpdateJournal` from `@meridian/agent-edit`. Retained for the Step 9
adapter (`drizzle-journal`) to delegate to.

### Agent-edit adapters

- `drizzle-journal.ts` implements `UpdateJournal` over the v3 Yjs journal tables.
- `document-loader.ts` is the pure journal → encoded Yjs state rebuild helper.
  Hocuspocus `onLoadDocument` must call this when the WS route is rewired.
- `hocuspocus-coordinator.ts` implements `DocumentCoordinator` with Hocuspocus
  direct connections plus `KeyedMutex` per-doc serialization. It depends on the
  same loader for existence checks and idempotent recovery.

## Stale claims removed

The following claims in the previous docs were true before extraction but are
now false — removed in this update:
- **"DocumentSyncService is the live document spine"** — the service is now a
  throwing stub. The live document spine lives in `@meridian/agent-edit`.
- **"Transport is Hocuspocus v4"** — the old all-in-one Hocuspocus collab
  adapter was deleted. The replacement is split: `@meridian/agent-edit` owns
  the tool core, and this domain owns thin Hocuspocus/journal adapters that are
  still awaiting composition-root and WS wiring.
- **"No node or mark without a lossless serializer+parser pair in
  domain/mdx-bridge.ts"** — `mdx-bridge.ts` was deleted. The serializer lives
  in `@meridian/agent-edit`'s codec registration system; the rule still holds
  but at the package level.
- **"The ProseMirror schema is the bijection"** — still architecturally true,
  but the bijection now lives in the codec package, not here.

## Cutover (Step 9)

See [`collab/AGENTS.md`](../AGENTS.md) for the cutover checklist. The
`TODO(agent-edit)` markers in `collab/index.ts` and ~13 consumers are the
exhaustive scope.
