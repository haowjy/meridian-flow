# domains/context — ContextPort

Agent-readable/writable project workspace context addressed by `context://` URIs. Split
out of the former `domains/content` grab-bag.

## What it owns

- **`ContextPort`** — the read/write/list/search surface tools use to reach
  project workspace context.
- **URI routing** — `parseContextUri` / `toCanonical` + `createContextPortRouter`
  dispatch a URI to the adapter for its scheme.
- **Schemes:** `fs1 | kb | work | user` (the `package` scheme was removed in the
  phase-1 cleanup; reintroduce only when `domains/packages` backs it for real).
- **ContextFS document stores & Yjs mirrors** — public context trees/projections live in stores;
  fs1/kb/work/user content is read/written through `DocumentSyncService`.
- **Figure assets** — figure upload/signing orchestration for context documents
  with bytes stored through `domains/storage`'s object-store primitive.
- **Internal thread-upload backing docs** — system-only upload documents live in
  an internal `thread_uploads` context source, outside public `kb://`, `work://`,
  and `user://` trees. `uploads/` owns the chat upload/recent rails projection
  and the import pipeline (object bytes → backing document → Yjs mirror → thread
  attachment).

## Contracts (ports)

| Port | Shape |
|---|---|
| `ContextPort` | `stat / read / write / list / search` — all return `Result<…, ContextError>`; `stat` is the narrow single-file resolver for tracked-vs-binary refs; `write` accepts optional context-local WriteProvenance (mapped to collab's update origin at the ContextFS boundary) |
| `ContextSchemeAdapter` | per-scheme adapter the router dispatches to (`SchemeCapabilities`) |
| `ContextDocumentStore` | `UpsertDocumentInput` → durable doc rows + search |

Fallible operations return `Result<T, ContextError>` (not throws). Search
scoped to a scheme root (e.g. `kb://`) stays in-scheme; an unscoped search fans
out across writable schemes.

## Adapters

- `ContextFS` over `ContextDocumentStore` for folder/projection plus
  `DocumentSyncPort` for canonical markdown content.
- Figure asset service under `figures/`, `FigureDocumentRepository` port under
  `ports/`, and Drizzle/in-memory repository adapters under `adapters/figures/`.

## Invariants & known gaps

- **Yjs-canonical content for fs1/kb/work/user.** Reads resolve the document row,
  seed/get the mirror by `ContextDocument.id`, then return `readAsMarkdown`.
  Writes create/resolve the row, write to Yjs with attribution, then persist
  the Yjs read-back to `documents.markdown_projection` as a derived cache/search
  index. See [collab/.context/CONTEXT.md](../../collab/.context/CONTEXT.md) for the canonical-representation invariant (markdown = semantic/interchange, Yjs = merge/provenance).
- **Thread uploads use an internal source, not `work://.uploads`.** The route calls
  `ThreadUploadImportService`, which owns object put → upload document row →
  Yjs mirror seed → thread attach. The context-owned internal upload store
  provisions a project workspace-scoped `thread_uploads` source that is not registered in
  the public ContextPort router, so dotfiles like `.env`/`.gitignore` remain
  valid user-visible paths while upload backing docs stay hidden. Binary object
  writes are cleaned up best-effort on downstream failure; tracked mirror cache is
  evicted when the import transaction rolls back after mirror seeding.
- **Figure upload is two-phase and partially-failure-safe** (`figures/figure-assets.ts`, with persistence behind `ports/figure-document-repository.ts`).
  Object write → DB `attachDocumentFile` is not atomic, so on attach throw or a
  missing-document result the freshly-written object is deleted best-effort
  (`deleteObjectBestEffort`); on a successful replace the *old* object is likewise
  cleaned up best-effort. Signed-URL generation for the response is best-effort
  (2 attempts) — a sign failure still returns the persisted reference with an
  empty `signedUrl` / epoch `signedUrlExpiresAt` rather than failing the upload.
  All cleanup failures are logged, never thrown.
- **Production tree/projection wiring is durable.** `context-port-factory.ts`'s
  `createProductionContextPortFactory()` builds Drizzle-backed context stores
  over lazily provisioned per-project workspace `context_sources` rows for `fs1`, `kb`,
  `work`, and `user`. It shares the production `DocumentSyncService`, so content
  writes hit the Yjs update log while `documents.markdown_projection` remains
  the derived search/listing cache.

## Wiring

`compose.ts` exposes `contextPorts: ContextPortFactory`; the orchestrator's core
tools read/write context through it with `forProject workspace(project workspaceId, userId)`.

`context-port-factory.ts` lives in this domain and owns production/in-memory
ContextPortFactory construction. `uploads/` owns thread upload import/backing
documents. `promotion/` owns result promotion and the
`createOrchestratorCheckpointArtifactFlush()` factory used by runtime checkpoint
boundaries.
