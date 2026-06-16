# domains/context — context filesystem primitives (unified)

Agent-readable/writable project workspace content addressed by context URIs.
The context-URI cleanse (A0–A3) deleted the legacy dual-port and replaced it
with a single unified `ContextPort` that resolves durable project schemes
(`manuscript://`, `kb://`, `user://`) and ephemeral work-scoped schemes
(`work://<workId>/…`, `uploads://<workId>/…`).

## What it owns

- **Unified `ContextPort`** — single port interface (`ports/context-port.ts`)
  providing `stat`/`read`/`write`/`writeBinary`/`mkdir`/`list`/`search` for all
  schemes. Resolved through `contextPortForThread` (the resolver in
  `context-port-resolution.ts`); callers never use `forProject`/`forWork` directly.
- **Context URI primitives** — `parseUnifiedContextUri` / `toCanonical`
  normalize the five registered schemes: `manuscript`, `kb`, `user`, `work`,
  `uploads`. Bare paths default to `manuscript://`. Work-scoped schemes
  (`work://`, `uploads://`) carry a `<workId>` authority.
- **Unified context port factory** (`unified-context-port-factory.ts`) — two deep
  modules: `context-source-provisioning.ts` (race-safe `context_sources`
  provisioning + lazy promise-cached resolution) and the factory composition root.
- **ContextPort router** (`context/router.ts`) — dispatches scheme-relative paths
  to the correct scheme adapter; converts faults into `ContextError` results with
  the canonical URI attached.
- **Scheme/storage ports** — `ContextPort`, `ContextSchemeAdapter`,
  `ContextDocumentStore`, and `ContextTreeMutationStore` (for `move`/`delete`
  with CAS conformance).
- **ContextFS** — the reference/production adapter: maps a slash-delimited file
  tree onto `ContextDocumentStore` rows and `DocumentSyncPort` Yjs mirrors.
- **Collab-aware document sync** (`context/collab-document-sync.ts`) — routes
  agent/human writes through `DocumentSyncService` (validateAgentTurn,
  touchDocumentActivity, corrupt-mirror recovery) while system/import writes
  stay on the inner sync port. Atomic `edit()` preserves the read→transform→write
  path.
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
- Work-scoped schemes (`work://`, `uploads://`) carry a `<workId>` authority.
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
- Text documents are Yjs-canonical. Reads seed/get the mirror from the store's
  markdown projection, then return `DocumentSyncPort.readAsMarkdown`. Writes
  write through `DocumentSyncPort.writeFromMarkdown`, read back from Yjs, and
  persist that projection into the store for listing/search.
- `WriteProvenance` is mapped at the adapter boundary to collab update origins:
  agent provenance uses `turnId`, human provenance uses `userId`, and omitted
  provenance is system-originated.
- Collab-aware writes (agent/human) route through `collab-document-sync.ts`
  for `validateAgentTurn`, `touchDocumentActivity`, and corrupt-mirror recovery.
- Binary documents are storage-backed metadata rows. `read` rejects them as
  `io_error`; `stat`/`list` return binary refs with storage URL and MIME data.
- `move`/`delete` use `ContextTreeMutationStore` with CAS location tokens
  (atomic read→write/deletion-path guard).

## Deleted (cleanse removal)

- **Legacy `ContextPortFactory`** (dual-port with `forThread`/`forProject`) — deleted.
- **`fs1://`** scheme — sandbox-era vestige, removed.
- **`work://.results`** — promotion cruft, removed. Results → `work://<workId>/results/…`.
- **`LegacyThreadContextPort`** / `manuscriptContextPort` / `REQUIRED_MANUSCRIPT_URI` — deleted.
- **Corpus-import domain ceremony** — folded into `kb://imports/…` ingest.

## Negative space

This slice uses generic context vocabulary. Do not reintroduce alternate auth
adapter seams, sandbox filesystem assumptions, or upstream product naming.
External connectors (google_drive/dropbox/notion) are schema-only — no
implementation. The `results://` scheme does not exist.
