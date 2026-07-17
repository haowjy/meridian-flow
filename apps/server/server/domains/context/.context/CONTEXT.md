# domains/context — context filesystem primitives (unified)

Agent-readable/writable project workspace content addressed by context URIs.
The context-URI cleanse (A0–A3) deleted the legacy dual-port and replaced it
with a single unified `ContextPort` that resolves durable project schemes
(`manuscript://`, `kb://`, `user://`) and work-item-scoped schemes
(`scratch://<workId>/…`, `uploads://<workId>/…`).

## What it owns

- **Unified `ContextPort`** — single port interface (`ports/context-port.ts`)
  providing `stat`/`read`/`write`/`writeBinary`/`mkdir`/`list`/`search` for all
  schemes. Resolved through `contextPortForThread` (the resolver in
  `context-port-resolution.ts`); callers never use `forProject`/`forWork` directly.
- **Context URI primitives** — `parseUnifiedContextUri` / `toCanonical`
  normalize the five registered schemes: `manuscript`, `kb`, `user`, `scratch`,
  `uploads`. Bare paths default to `manuscript://`. Work-scoped schemes
  (`scratch://`, `uploads://`) carry a `<workId>` authority.
- **Unified context port factory** (`unified-context-port-factory.ts`) — two deep
  modules: `context-source-provisioning.ts` (race-safe `context_sources`
  provisioning + lazy promise-cached resolution) and the factory composition root.
- **ContextPort router** (`context/router.ts`) — dispatches scheme-relative paths
  to the correct scheme adapter; converts faults into `ContextError` results with
  the canonical URI attached. Router and tree-move boundaries share the canonical
  mapper in `context/adapter-fault.ts`, including actionable invalid-operation messages.
- **Scheme/storage ports** — `ContextPort`, `ContextSchemeAdapter`,
  `ContextDocumentStore`, and `ContextTreeMutationStore` (for `move`/`delete`
  with CAS conformance).
- **ContextFS** — the reference/production adapter: maps a slash-delimited file
  tree onto `ContextDocumentStore` rows and the collab domain's Yjs document
  state.
- **Collab-aware markdown bridge** (`context/collab-document-sync.ts`) — maps
  ContextFS provenance to collab origins. Agent/human writes use the richer
  collab write APIs that return attribution metadata; system/import writes use
  the markdown write API directly. The certified `ContextPort.edit` boundary is
  a closed command surface; its current command is a fresh end-of-document
  append. Opaque caller callbacks do not cross the boundary.
- **Context tree mover** (`context/context-tree-mover.ts`) — CAS preflight/commit
  for `move`/`delete` operations.
- **Corpus import** — folded into `kb://imports/…` ingest (ceremony deleted;
  `corpus-import-service.ts` keeps slugging/dedupe/normalization helpers).
- **Browse layer scheme** (`browse-layer-scheme.ts`) — HTTP browse scheme
  vocabulary, routing, and work-scope membership gating for work-scoped schemes.

## Contracts

| Contract | Shape |
|---|---|
| `ContextPort` (`ports/context-port.ts`) | Result-returning filesystem surface: `stat`, `read`, `write`, `writeBinary`, `mkdir`, `list`, `search`, `edit`, `move`, `delete`. No errors cross as throws. |
| `ContextSchemeAdapter` | Scheme-local adapter over normalized paths. It never parses URIs; it returns scheme-relative paths and scope-free `AdapterFault`s. |
| `ContextDocumentStore` | Primitive folder/document backing store for one context source. |
| `ContextTreeMutationStore` | Tree-aware mutation store with CAS conformance (`move`/`delete` with location tokens). |

## URI and router invariants

- Canonical context URIs are `scheme://[authority]/path`; a scheme root is `scheme://`.
- Bare paths default to `manuscript://` (project-scoped).
- Leading/trailing slashes and repeated slashes are normalized away; `.` segments
  are dropped; `..` is rejected.
- Work-scoped schemes (`scratch://`, `uploads://`) carry a `<workId>` authority.
  Omitted authority resolves to the thread's primary Work. `manuscript://`,
  `kb://`, `user://` carry no work authority.
- Strings that look scheme-prefixed but omit `//` are invalid, not bare paths.
- Router methods attach the canonical URI to every `ContextError`.
- Adapter `Ok(null)` becomes `not_found`; `permission_denied`,
  `context_unavailable`, and `io_error` stay generic context/backing-store
  faults.
- Unscoped `search(query)` fans out across searchable adapters best-effort.

## ContextFS invariants

- `ContextFS` owns normalized path ↔ folder/document resolution and creates
  missing folders on writes and `mkdir`.
- Text documents are Yjs-canonical. Reads call the collab domain's
  `readAsMarkdown` directly. Writes flow through collab markdown/write APIs,
  read back from Yjs, and persist that projection by stable document ID for
  listing/search. A concurrent move can change the path, never which row receives
  the post-write projection.
- Every text create/seed/write path resolves filetype before constructing Yjs
  content. New documents derive it from the path and persist it before calling
  the collab engine; existing documents write with their persisted classification
  and never reclassify around a Yjs write. The engine resolves that metadata to
  the client-mounted schema. Never construct a fragment with an assumed markdown
  schema.
- File moves own path-driven classification changes. A tracked rename within the
  same Yjs schema updates path metadata and filetype in the same CAS commit.
  Document↔code and tracked↔binary/custom moves return a message-bearing
  `invalid_operation` until an explicit schema/storage conversion exists.
- Text create/write boundaries reject registry filetypes without a tracked Yjs
  schema before mutating the context tree. Binary content must enter through
  `writeBinary`/the upload flow; unknown extensions remain tracked prose.
- Tracked writes also reject an existing storage-backed row before collab work;
  the document-store upsert boundary independently refuses binary-to-tracked
  conversion so storage URL and MIME metadata cannot be erased.
- Tracked documents default to the full document schema. The strict code schema
  is an explicit filetype allowlist (`python`, `typescript`, `javascript`,
  `json`, `shell`, `yaml`, `csv`). One exhaustive contracts disposition registry
  classifies every registered filetype; unknown persisted prose defaults to the
  document schema, while registered non-tracked metadata is a typed I/O fault.
- Client-minted untitled documents use the distinct `createUntitledDocument`
  boundary: it atomically allocates `Untitled N`, persists `provisionalName`,
  and only ensures an empty Yjs authority. The client owns initial CRDT content;
  this path must never seed markdown. Creation finalization is repairable: both
  new creates and idempotent retries re-ensure manifest membership and the Yjs
  authority after the document row exists. A successful basename change clears the
  flag in the shared tree-mutation store, while path-only moves preserve it.
- Every **project-scoped** document creation (`manuscript`, `kb`, `user`)
  registers in the project manifest via the required manifest-membership port
  wired in `unified-context-port-factory.ts`. The ws live-room gate denies connections
  for non-members, so any unregistered document renders a permanently dead
  editor. Manifest seeding is scheme-agnostic; incremental registration must be
  too. (Work-scoped sources have no `projectId` and are still outside this
  path — see issue #206 before relying on scratch/uploads collab.)
- `WriteProvenance` is mapped at the adapter boundary to collab update origins:
  agent provenance uses `turnId`, human provenance uses `userId`, and omitted
  provenance is system-originated.
- Collab-aware writes (agent/human) route through `collab-document-sync.ts` for
  provenance mapping and attribution-bearing write results. Document-activity
  touching is a separate post-write hook and is not part of this bridge yet.
- Binary documents are storage-backed metadata rows. `read` rejects them as
  `io_error`; `stat`/`list` return binary refs with storage URL and MIME data.
- `move`/`delete` use `ContextTreeMutationStore` with CAS location tokens
  (atomic read→write/deletion-path guard).

## Deleted (cleanse removal)

- **Legacy `ContextPortFactory`** (dual-port with `forThread`/`forProject`) — deleted.
- **`fs1://`** scheme — sandbox-era vestige, removed.
- **`scratch://.results`** — promotion cruft, removed. Results → `scratch://<workId>/results/…`.
- **`LegacyThreadContextPort`** / `manuscriptContextPort` / `REQUIRED_MANUSCRIPT_URI` — deleted.
- **Corpus-import domain ceremony** — folded into `kb://imports/…` ingest.

## Negative space

This slice uses generic context vocabulary. Do not reintroduce alternate auth
adapter seams, sandbox filesystem assumptions, or upstream product naming.
External connectors (google_drive/dropbox/notion) are schema-only — no
implementation. The `results://` scheme does not exist.

## Downlinks

- [Collab write codec and schema coherence](../../collab/.context/CONTEXT.md)
