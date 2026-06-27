# collab — server-side document infrastructure

The Yjs editing engine lives in `@meridian/agent-edit` (`packages/agent-edit/`).
This server domain supplies concrete persistence/transport adapters and exposes a
`CollabDomain` for context, upload, route, and WS callers.

## Current shape

| Concern | Location | Status |
|---|---|---|
| Tool core (`write()`, undo/redo, compaction) | `@meridian/agent-edit` | Extracted package |
| Codec/model factories | `@meridian/agent-edit` + `@meridian/prosemirror-schema` | Composed by server |
| Application-facing collab domain | `collab/index.ts`, `collab/composition.ts` | Facade wiring over package codec/model plus journal/coordinator |
| Full-document markdown SET/read | `collab/domain/markdown-document.ts` | Server-side engine over package primitives; not package public API |
| Journal/mutation persistence | `collab/adapters/drizzle-journal.ts` | Production `UpdateJournal` with mutation queries, lifecycle, checkpoint, and latest-update helpers |
| Live-doc coordination | `collab/adapters/hocuspocus-coordinator.ts` | Production `DocumentCoordinator` |
| Hocuspocus load | `collab/adapters/document-loader.ts` | Rebuilds Y.Doc state from journal |
| In-memory app/test adapters | `collab/adapters/in-memory/agent-edit.ts` | Real in-memory journal/coordinator/lifecycle |
| Document write read models | `collab/domain/document-activity.ts` | Production post-write hook for activity/projection |

## Domain behavior

### Full-document SET

`writeFromMarkdown` and `writeDocument` intentionally do not add a package
`set` command. `domain/markdown-document.ts` parses markdown with the package
codec, clones the live Y.Doc into a draft, deletes the ProseMirror fragment
contents, inserts the parsed blocks through the package model, appends the
resulting Yjs update to the journal, then applies that update to the live doc.
Mutating the draft before append keeps the live doc from advancing if
persistence fails.

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

`document_yjs_heads.latest_checkpoint_id` is a Drizzle-declared FK to
`document_yjs_checkpoints.id` (`ON DELETE SET NULL`). In production, checkpoints
are append-only: compaction deletes retained update rows, not checkpoint rows, and
checkpoints disappear with their parent document cascade. The `SET NULL` action is
a defensive database behavior, not an ordinary lifecycle path.

**Stale-schema guard (invariant).** `document_yjs_heads.schema_version` is stamped
with the running `COLLAB_SCHEMA_VERSION` on every head upsert, but upsert uses a
monotonic `greatest(stored, current)` assignment so a downgraded server cannot
stamp the head backward and erase the fence. The journal read path refuses to
replay bytes from an older schema: `journal.read()` (and thus
`loadDocumentState`, the cold-open `persistedState`, and `recover`) calls
`assertReadableHead` and throws `StaleDocumentSchemaError` when the stored version
is behind. This converts silent y-prosemirror corruption on a schema bump into a
loud, detectable failure. The rule is explicit, not incidental: `ensureDocument`
must `assertReadableHead` **before** `upsertHead` — stamping the current version
first would erase the evidence and silently disable the guard.

Recovery/rebuild from a trusted source on a stale version is deferred to
[#94](https://github.com/haowjy/meridian-flow/issues/94); the guard only blocks.
The guard is still one-sided: a server older than the stored head version preserves
the newer fence but does not reject replay. Rejecting newer-than-current heads is
tracked in [#95](https://github.com/haowjy/meridian-flow/issues/95) because it
needs a rollout compatibility decision.

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
  the coordinator; pending appends are tracked by document. It first rejects any
  update carrying a struct in the reserved clientID band (see below): the update
  is dropped and the document is flagged unsafe-for-checkpoint.
- `storeHocuspocusDocument` drains pending appends for that document, captures
  the latest persisted update seq, then writes a checkpoint from
  `Y.encodeStateAsUpdate(document)`. The seq is captured before encoding so a
  concurrent append is replayed instead of hidden by the checkpoint.
- `drainHocuspocusPersistence` waits for tracked appends. Metrics report pending
  depth, oldest pending age, failed/dropped append count, live docs, and open
  Hocuspocus connections.
- Connection-update appends are collaborative keystroke persistence, not
  document-level write events, so they do not fire the activity/projection hook.

### Reserved Yjs clientID band

Yjs identifies CRDT items by `(clientID, clock)`; two writers sharing a clientID
corrupt the doc permanently. The band `[0, RESERVED_CLIENT_ID_MAX]` (999, defined
in `@meridian/prosemirror-schema`) is reserved for **server-authored reversal**
writing — `composition.ts` injects `AGENT_EDIT_UNDO_CLIENT_ID` (999) into the
agent-edit write tool. Two invariants keep the band exclusive:

- **No live writer draws into the band.** Every content-authoring `Y.Doc` (the
  browser editor and all server adapters) is built via `createCollabYDoc()`,
  which re-rolls any clientID `<= 999`. agent-edit stays host-agnostic: its
  forward runtime docs come from an injected `createRuntimeDoc` factory wired to
  `createCollabYDoc` at this composition root.
- **Inbound band updates are rejected at ingest.** `persistConnectionUpdate`
  drops any connection update with a struct in the band and marks the doc
  unsafe-for-checkpoint, so a forged/misbehaving client can't collide with the
  reversal stream.

Reversal is served entirely by cold reconstruction (no live `Y.UndoManager`).
Cold-reconstruction latency stays interactive because checkpoint freshness is
maintained by Hocuspocus's debounced store (`debounce: 2000, maxDebounce: 10000`
in the WS route) — a checkpoint every ≤10s of active editing bounds the replay
window.

## Stable server-side helpers

`document-activity.ts` contains DB helpers for document write read models:
`touchDocumentActivity` and `updateMarkdownProjection`. `createCollabDomain`
wires them through the facade document-write hook; the in-memory collab domain
passes no hook.

## Deferred cutover work

- Keep schema-parity and TipTap extension work in the package cutover plan.
