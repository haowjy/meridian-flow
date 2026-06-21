# domains/collab — cutover scaffolding

This domain held the server's Yjs sync engine + markdown/MDX codec. The engine
was **extracted to `@meridian/agent-edit`** (`packages/agent-edit/`). The domain
presently holds:

- **Temporary throwing-stub facade** (`index.ts`) — `DocumentSyncPort`,
  `DocumentSyncFacade`, `DocumentSyncService` types that compile against ~13
  consumers. Every method throws `"Old collab code deleted"`. This is cutover
  scaffolding for Step 9, not a permanent interface.
- **Server-side helpers** — `domain/document-activity.ts` (touch timestamps,
  markdown projection update). Stays server-side — these are DB-side effects, not
  agent-edit concerns.
- **Adapters** — `adapters/drizzle/document-store.ts` and
  `adapters/in-memory/document-store.ts`. These are the old row-level store; the
  new `UpdateJournal` adapter lands in Step 9.
- **Ports** — `ports/document-store.ts` (old `DocumentStore` interface). Being
  superseded by `UpdateJournal` from `@meridian/agent-edit`.

## Cutover (Step 9, next session)

`TODO(agent-edit)` markers throughout the codebase:
1. Delete the `DocumentSync*` facade bridge from `index.ts`.
2. Install real adapters: `@meridian/agent-edit` + Hocuspocus coordinator +
   Drizzle journal + composition root in `server/lib/app.ts`.
3. Rewire the ~13 consumers to `@meridian/agent-edit`'s `write()` surface.
4. Replace `createInMemoryAppServices` Hocuspocus no-ops with real in-memory
   agent-edit adapters or explicit throws.

## What stayed server-side

- `document-activity.ts` — `touchDocumentActivity`, `updateMarkdownProjection`
  remain here. These are DB-side side effects on document writes, not agent-edit
  concerns.
- `document-store.ts` port + adapters — retained as the row-level store until
  Step 9 replaces it with `UpdateJournal`.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
