# collab — server-side document infrastructure

The Yjs editing engine lives in `@meridian/agent-edit` (`packages/agent-edit/`).
This server domain supplies concrete persistence/transport adapters and keeps a
temporary `DocumentSyncFacade` for existing context, upload, route, and WS
callers.

## Current shape

| Concern | Location | Status |
|---|---|---|
| Tool core (`write()`, undo/redo, compaction) | `@meridian/agent-edit` | Extracted package |
| Codec/model factories | `@meridian/agent-edit` + `@meridian/prosemirror-schema` | Composed by server |
| Facade compatibility | `collab/index.ts`, `collab/composition.ts` | Real adapter, temporary API |
| Journal persistence | `collab/adapters/drizzle-journal.ts` | Production `UpdateJournal` |
| Live-doc coordination | `collab/adapters/hocuspocus-coordinator.ts` | Production `DocumentCoordinator` |
| Hocuspocus load | `collab/adapters/document-loader.ts` | Rebuilds Y.Doc state from journal |
| Lifecycle/checkpoint facade ops | `collab/adapters/drizzle-facade-store.ts` | Server-only DB helpers |
| In-memory app/test adapters | `collab/adapters/in-memory/agent-edit.ts` | Real in-memory journal/coordinator/lifecycle |
| Old document store | `collab/ports/`, `collab/adapters/drizzle/`, `collab/adapters/in-memory/document-store.ts` | Kept until facade deletion pass |

## Facade behavior

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

Facade origins remain collab-shaped:

- `{ type: "agent", actorTurnId }` → `agent:<turnId>` with `actorTurnId`
- `{ type: "user", userId/actorUserId }` → `human:<userId>`
- `{ type: "import", userId, ... }` → `human:<userId>`; if imports later become
  userless, map them to `system`
- `{ type: "system" }` → `system`

Attribution maps package `human:<userId>` back to facade/API `originType:
"user"`.

### Hocuspocus persistence

The WS route calls the facade hooks:

- `loadHocuspocusDocument` replays checkpoint + updates via `loadDocumentState`.
- `persistConnectionUpdate` appends the connection update to the journal outside
  the coordinator; pending appends are tracked by document.
- `storeHocuspocusDocument` drains pending appends for that document, then writes
  a checkpoint from `Y.encodeStateAsUpdate(document)`.
- `drainHocuspocusPersistence` waits for tracked appends. Metrics report pending
  depth, oldest pending age, failed/dropped append count, live docs, and open
  Hocuspocus connections.

## Stable server-side helpers

`document-activity.ts` contains DB side effects for document writes:
`touchDocumentActivity` and `updateMarkdownProjection`. They remain outside the
package because they update Meridian read models and project/work activity.

## Deferred cutover work

- Rewire consumers from `DocumentSyncFacade` to package/core-facing ports.
- Delete mirror method names and the old row-level `DocumentStore` once no
  consumer depends on them.
- Re-enable the `TODO(agent-edit)` skipped tests after consumer rewiring.
