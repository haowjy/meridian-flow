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

## Domain behavior

### Full-document SET

`writeFromMarkdown` and `writeDocument` intentionally do not add a package
`set` command. The server helper parses markdown with the package codec, clones
the live Y.Doc into a draft, deletes the ProseMirror fragment contents, inserts
the parsed blocks through the package model, appends the resulting Yjs update to
the journal, then applies that update to the live doc. Mutating the draft before
append keeps the live doc from advancing if persistence fails.

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
- `storeHocuspocusDocument` drains pending appends for that document, then writes
  a checkpoint from `Y.encodeStateAsUpdate(document)`.
- `drainHocuspocusPersistence` waits for tracked appends. Metrics report pending
  depth, oldest pending age, failed/dropped append count, live docs, and open
  Hocuspocus connections.

## Stable server-side helpers

`document-activity.ts` contains DB helpers for document write read models:
`touchDocumentActivity` and `updateMarkdownProjection`. The post-write hook that
invokes them is intentionally deferred to a later pass.

## Deferred cutover work

- Wire the document-activity post-write hook.
- Keep schema-parity and TipTap extension work in the package cutover plan.
