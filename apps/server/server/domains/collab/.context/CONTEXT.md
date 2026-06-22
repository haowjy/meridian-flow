# collab — server-side document infrastructure

The Yjs editing engine lives in `@meridian/agent-edit` (`packages/agent-edit/`).
This server domain supplies concrete persistence/transport adapters and exposes a
`CollabDomain` for context, upload, route, and WS callers.

## Current shape

| Concern | Location | Status |
|---|---|---|
| Tool core (`write()`, undo/redo, compaction) | `@meridian/agent-edit` | Extracted package |
| Codec/model factories | `@meridian/agent-edit` + `@meridian/prosemirror-schema` | Composed by server |
| Application-facing collab domain | `collab/index.ts`, `collab/composition.ts` | Real adapter over package core |
| Journal persistence | `collab/adapters/drizzle-journal.ts` | Production `UpdateJournal` |
| Live-doc coordination | `collab/adapters/hocuspocus-coordinator.ts` | Production `DocumentCoordinator` |
| Hocuspocus load | `collab/adapters/document-loader.ts` | Rebuilds Y.Doc state from journal |
| Lifecycle/checkpoint ops | `collab/adapters/drizzle-facade-store.ts` | Server-only DB helpers |
| In-memory app/test adapters | `collab/adapters/in-memory/agent-edit.ts` | Real in-memory journal/coordinator/lifecycle |
| Document write read models | `collab/domain/document-activity.ts` | Production post-write hook for activity/projection |

## Domain behavior

### Full-document SET

`writeFromMarkdown` and `writeDocument` intentionally do not add a package
`set` command. The server helper parses markdown with the package codec, clones
the live Y.Doc into a draft, deletes the ProseMirror fragment contents, inserts
the parsed blocks through the package model, appends the resulting Yjs update to
the journal, then applies that update to the live doc. Mutating the draft before
append keeps the live doc from advancing if persistence fails.

After a full-document write has appended to the journal and applied to the live
Y.Doc, `setMarkdown` / `editMarkdown` fire the injected document-write hook. The
production hook updates document activity rollups and `documents.markdownProjection`.
It is awaited so callers see fresh read models when the hook succeeds, but hook
failures are logged through `EventSink` and do not fail or roll back the
committed journal write.

### Reads

`readAsMarkdown` is a thin codec/model read under `DocumentCoordinator` access.
It serializes raw markdown without block-hash view prefixes.

### Lifecycle

`createServerDocumentLifecycle.ensureDocument(docId)` upserts the
`document_yjs_heads` row and creates an empty Yjs checkpoint when the journal has
no state. The Yjs tables FK to `documents.id`; callers are expected to create the
`documents` row before ensuring collab state.

### Origin translation

Public origins remain collab-shaped:

- `{ type: "agent", actorTurnId }` → `agent:<turnId>` with `actorTurnId`
- `{ type: "user", userId/actorUserId }` → `human:<userId>`
- `{ type: "import", userId, ... }` → `human:<userId>`; userless imports map to
  `system`
- `{ type: "system" }` → `system`

Attribution maps package `human:<userId>` back to API `originType: "user"`.

### Hocuspocus persistence

The WS route calls the collab domain hooks:

- `loadHocuspocusDocument` replays checkpoint + updates via `loadDocumentState`.
- `persistConnectionUpdate` appends the connection update to the journal outside
  the coordinator; pending appends are tracked by document.
- `storeHocuspocusDocument` drains pending appends for that document, captures
  the latest persisted update seq, then writes a checkpoint from
  `Y.encodeStateAsUpdate(document)`. The seq is captured before encoding so a
  concurrent append is replayed instead of hidden by the checkpoint.
- `drainHocuspocusPersistence` waits for tracked appends. Metrics report pending
  depth, oldest pending age, failed/dropped append count, live docs, and open
  Hocuspocus connections.
- Connection-update appends are collaborative keystroke persistence, not
  document-level write events, so they do not fire the activity/projection hook.

## Stable server-side helpers

`document-activity.ts` contains DB helpers for document write read models:
`touchDocumentActivity` and `updateMarkdownProjection`. `createCollabDomain`
wires them through the facade document-write hook; the in-memory collab domain
passes no hook.

## Deferred cutover work

- Keep schema-parity and TipTap extension work in the package cutover plan.
