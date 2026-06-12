# domains/context — context filesystem primitives

Agent-readable/writable project workspace context addressed by context URIs. The
current slice ports the upstream filesystem-shaped primitives while leaving the
older runtime-facing thread document factory in place.

## What it owns

- **Legacy runtime `ContextPortFactory`** in `index.ts` — `forThread({ threadId, userId })`
  still exposes `readDocument` / `writeDocument` / `editDocument` for the turn
  tool registry. Production support is intentionally narrow: it resolves only
  `work://manuscript/chapter-1.md`, verifies thread/work/user ownership through
  Drizzle, and delegates writes/edits to `DocumentSyncService`.
- **Context URI primitives** — `parseContextUri` / `toCanonical` normalize the
  four registered schemes: `fs1`, `kb`, `work`, and `user`.
- **ContextPort router** — `createContextPortRouter` parses a URI, dispatches to
  a scheme adapter, and converts adapter faults or thrown backend errors into
  `ContextError` results with the canonical URI attached.
- **Scheme/storage ports** — `ContextPort`, `ContextSchemeAdapter`, and
  `ContextDocumentStore` define the filesystem contract independently of any
  Drizzle or object-storage adapter.
- **ContextFS reference adapter** — `ContextFS` maps a slash-delimited file tree
  onto `ContextDocumentStore` rows and `DocumentSyncPort` Yjs mirrors; the
  in-memory store is the reference/test backing implementation.

## Contracts

| Contract | Shape |
|---|---|
| Legacy `ContextPortFactory` (`index.ts`) | Thread-scoped `readDocument` / `writeDocument` / `editDocument` over `work://manuscript/chapter-1.md`; throws `HTTPError` at the route/runtime boundary. |
| `ContextPort` (`ports/context-port.ts`) | Result-returning filesystem surface: `stat`, `read`, `write`, `writeBinary`, `mkdir`, `list`, `search`. No errors should cross this boundary as throws. |
| `ContextSchemeAdapter` | Scheme-local adapter over normalized paths. It never parses URIs; it returns scheme-relative paths and scope-free `AdapterFault`s. |
| `ContextDocumentStore` | Primitive folder/document backing store for one context source. Path resolution and folder creation live in `ContextFS`, not in the store. |

The two `ContextPort` names are temporary: `index.ts` keeps the old thread-tool
port, while `ports/context-port.ts` defines the upstream-style filesystem port.
When wiring moves fully to the router/adapter path, resolve that naming overlap
instead of adding another alias.

## URI and router invariants

- Canonical context URIs are `scheme://path`; a scheme root is `scheme://`.
- Bare paths default to `fs1://` for copied upstream tool parity.
- Leading/trailing slashes and repeated slashes are normalized away; `.` segments
  are dropped; `..` is rejected.
- Strings that look scheme-prefixed but omit `//` (`kb:notes.md`) are invalid,
  not bare `fs1` paths.
- Router methods attach the canonical URI to every `ContextError`.
- Adapter `Ok(null)` becomes `not_found`; `permission_denied`,
  `context_unavailable`, and `io_error` stay generic context/backing-store
  faults. Unexpected adapter rejections become `io_error`.
- Unscoped `search(query)` fans out across searchable adapters best-effort: one
  failed backend is skipped rather than failing the whole search.

## ContextFS invariants

- `ContextFS` owns normalized path ↔ folder/document resolution and creates
  missing folders on writes and `mkdir`.
- Text documents are Yjs-canonical. Reads seed/get the mirror from the store's
  markdown projection, then return `DocumentSyncPort.readAsMarkdown`. Writes
  write through `DocumentSyncPort.writeFromMarkdown`, read back from Yjs, and
  persist that projection into the store for listing/search.
- `WriteProvenance` is mapped at the adapter boundary to collab update origins:
  agent provenance uses `turnId`, human provenance uses `userId`, and omitted
  provenance is system-originated.
- Binary documents are storage-backed metadata rows. `read` rejects them as
  `io_error`; `stat`/`list` return binary refs with storage URL and MIME data.
- The current adapter is last-write-wins. Folder creation and document upsert are
  find-then-create/find-then-upsert; concurrent writers to the same new path can
  race into a backing-store error that the router reports as `io_error`.

## Negative space

This slice intentionally uses generic context vocabulary. Do not reintroduce
WorkOS/AuthKit auth seams, Voluma naming, sandbox-aware filesystems, scientific
schemes, or executable package-runtime assumptions while extending these
primitives.
