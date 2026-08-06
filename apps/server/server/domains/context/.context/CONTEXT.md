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
(`scratch://`, `uploads://`) carry an `@<work-slug>` wire qualifier that the
router resolves to a stable Work ID before dispatch.
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
  for `move`/`delete` operations. Callers may request exact-target moves so an
  existing destination folder is a collision rather than a Unix-style container.
  Successful moves return the domain-committed destination path. The project
  context HTTP surface exposes cross-folder and cross-scheme moves, including
  explicit Work authorities on either side when a scheme is Work-scoped.
- **Figure asset service** (`figures/figure-assets.ts`) — two-phase upload
  (object write, then context document create) with partial-failure cleanup. An
  uploaded image becomes its own binary document under `manuscript://assets/`,
  identified by `assetDocumentId` and addressed in prose as `asset:<documentId>`.
  The host document is only authorized, never mutated, so replacing an image in
  one chapter cannot disturb another that references the same asset.
- **Asset-path resolver adapter** (`adapters/asset-path-resolver.ts`) — preloads
  persisted `manuscript://assets/` identities for codec composition and is
  updated immediately when figure upload creates a binary asset. A path shared
  by more than one asset resolves to nothing: the id direction is unique, the
  path direction is not.
- **Document-link resolver port** (`ports/document-link-resolver.ts`) — one
  resolution boundary for wikilink titles/aliases, `manuscript://` and
  `work://` locations, and paths relative to the containing document. The
  Drizzle adapter reads authoritative document/folder state for every
  resolution; the in-memory adapter obeys the same contract.
- **Corpus import** — folded into `kb://imports/…` ingest (ceremony deleted;
  `corpus-import-service.ts` keeps slugging/dedupe/normalization helpers).
- **Browse layer scheme** (`browse-layer-scheme.ts`) — HTTP browse scheme
  vocabulary, routing, and work-scope membership gating for work-scoped schemes.

## Contracts

| Contract | Shape |
|---|---|
| `ContextPort` (`ports/context-port.ts`) | Result-returning filesystem surface: `stat`, `read`, `write`, `createTrackedDocument`, `createUntitledDocument`, `ensureTrackedDocument`, `edit`, `writeBinary`, `move`, `commitWriterLocation`, `delete`, `list`, `mkdir`, and `search`. No errors cross as throws. |
| `ContextSchemeAdapter` | Scheme-local adapter over normalized paths. It never parses URIs; it returns scheme-relative paths and scope-free `AdapterFault`s. Its identity lookup lets the router recover a client-minted document across schemes. |
| `SchemeCapabilities` | Per-scheme `writable` / `searchable` / `creatable` declaration. The tree HTTP response exposes the same object used by router enforcement. |
| `ContextDocumentStore` | Primitive folder/document backing store for one context source, including project-wide stable-ID lookup used to classify idempotent creation retries. |
| `ContextTreeMutationStore` | Tree-aware mutation store with atomic `move`/provisional-graduation/`delete`. Location tokens compare stable node/source/path fields rather than content activity timestamps. |
| `DocumentLinkResolver` | `resolve({ projectId, workId?, target })` returns one canonical manuscript/Work document or `null`. A target is a discriminated `wikilink`, `scheme`, or `relative` value. |

## URI and router invariants

- Wire context URIs are `scheme://[@slug]/path`; a scheme root is `scheme://`.
  Canonical server results use the resolved Work ID so persisted references do
  not rebind if a deleted Work's slug is reused.
- Bare paths default to `manuscript://` (project-scoped).
- Leading/trailing slashes and repeated slashes are normalized away; `.` segments
  are dropped; `..` is rejected.
- Writer-created file and folder segments cannot begin with `@` at any depth.
  The prefix is reserved for Work authority qualifiers; interior `@` characters
  remain valid.
- Work-scoped schemes (`scratch://`, `uploads://`) accept one `@<work-slug>`
  qualifier. Omitted authority resolves to the thread's primary Work. Every
  active Work in the same project is addressable regardless of thread
  membership; cross-project Works are refused. `manuscript://`,
  `kb://`, `user://` carry no work authority.
- Strings that look scheme-prefixed but omit `//` are invalid, not bare paths.
- Wikilink title/alias matching is case-insensitive and trims outer whitespace.
  Scheme and relative paths are exact (an omitted final extension may match);
  relative traversal cannot escape its scheme root. `work://` maps to the
  selected Work's `scratch` source and serializes with its Work ID authority.
  Zero or multiple matches both resolve to `null`; resolution never guesses.
- Router methods attach the canonical URI to every `ContextError`.
- `uploads://` is intake, not an authoring workspace: tracked creation, untitled
  allocation, directory creation, and cross-scheme move-in are rejected with an
  actionable `invalid_operation`. Same-scheme moves and flat binary upload intake
  stay available; nested intake paths are rejected because they would implicitly
  create folders. `scratch://` remains fully writable and creatable, including
  nested binary intake.
- Writer-facing HTTP mutations use `context-mutation-validation.ts`, which delegates to the shared reason-coded path/name validators before constructing ContextPort URIs.
- Adapter `Ok(null)` becomes `not_found`; `permission_denied`,
  `context_unavailable`, and `io_error` stay generic context/backing-store
  faults.
- Unscoped `search(query)` fans out across searchable adapters best-effort.
- A `SearchResult` reports the first matching passages of a file (capped by the
  adapter) plus `matchCount`, the occurrences of the query in that whole file,
  including any past the cap. Each passage carries the block's prose as
  `excerpt` and, where documents serialize as hashlines (manuscript effective
  views), the `blockHash` a caller navigates by; that absence elsewhere is the
  contract. Hashline parsing lives once, in `adapters/context-fs/match.ts`,
  which scans one entry per block, matches against the body rather than the
  hash, and sends addressing and prose as separate values so nothing
  downstream has to know the format.

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
  boundary: it atomically allocates `Untitled N.md`, persists `provisionalName`,
  installs an empty Yjs authority, and records manifest membership in one
  transaction. The client owns initial CRDT content; this path must never seed
  non-empty markdown. Router-level retries locate the ID
  across every project scheme and authorized Work authority and return
  `already-materialized` with the actual canonical scheme/path/Work. This is
  distinct from a true allocation conflict. Response `name` is always the full
  basename including extension. A successful basename change clears the flag in
  the shared tree-mutation store, while path-only moves preserve it.
- Production text creation is one aggregate transaction: the context row, initial
  Yjs authority/content, and effective manifest membership either all commit or
  all roll back. Warm-room publication follows commit, so rollback cannot expose
  checkpoint or manifest state that SQL rejected. Create/read/list/edit use that
  manifest-aware view consistently, and observations fail closed when membership
  authority is unavailable. New non-empty content is parsed into a detached
  initialize-only checkpoint; work/thread manifest auto-push also waits for the
  aggregate commit.
  An older row missing membership is repaired on its next tracked-document touch;
  repair seeds absent Yjs state from the row projection and preserves existing
  canonical Yjs content. Work-scoped `scratch`/`uploads` stores resolve the project
  through their Work and deliberately register in the live view, not a work-draft
  view: the ws live-room gate checks the live project manifest.
- Work-scoped source provisioning and tree/content mutations lock and recheck the
  owning Work in their transaction. Work deletion takes the same lifecycle lock,
  so it cannot commit between authorization and a new scratch/upload mutation.
- Cross-source moves preserve document identity and therefore preserve the same live
  project-manifest membership; source scope is storage location, not a second
  manifest namespace. The move commit must not rewrite document Yjs authority or journal rows.
- `WriteProvenance` is mapped at the adapter boundary to collab update origins:
  agent provenance uses `turnId`, human provenance uses `userId`, and omitted
  provenance is system-originated.
- Collab-aware writes (agent/human) route through `collab-document-sync.ts` for
  provenance mapping and attribution-bearing write results. Document-activity
  touching is a separate post-write hook and is not part of this bridge yet.
- Binary documents are storage-backed metadata rows. `read` rejects them as
  `io_error`; `stat`/`list` return binary refs with storage URL and MIME data.
- `move`/`commitWriterLocation`/`delete` use `ContextTreeMutationStore` with
  location-only CAS tokens (atomic read→write/deletion-path guard). Markdown
  projection and activity writes may change `documents.updated_at` without
  invalidating a location plan. `stale_source` and `stale_target` remain typed
  through store, adapter, port, and HTTP route; only proven occupation is a
  `conflict` with an Open-existing locator.

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
