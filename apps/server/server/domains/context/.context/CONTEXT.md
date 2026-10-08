# domains/context — context filesystem primitives (unified)

Agent-readable/writable project workspace content addressed by context URIs.
The context-URI cleanse (A0–A3) deleted the legacy dual-port and replaced it
with a single unified `ContextPort` that resolves durable project schemes
(`manuscript://`, `kb://`, `user://`, `unfiled://`) and work-item-scoped schemes
(`scratch://@slug/…`, `uploads://@slug/…`) plus explicit no-Work `@/` authority.

## Revision queries and reads

Runtime uses the context-owned `DocumentRevisions.current` port, never collab
directly. Its adapter resolves the thread's current primary Work and write mode,
checks project-final availability, and in draft mode checks the thread's Work
manifest membership for `manuscript://` sources. It then delegates each
document to collab's effective reader. A document a re-read would not find
returns null, even when its Y.Doc remains loaded in Hocuspocus. Draft reads
pull live changes synchronously before selecting peer, Work draft, or live;
direct reads use live authority. The port may run inside a thread-locked
transaction; collab's pull transaction rules make that safe (see the
[collab contract](../../collab/.context/CONTEXT.md#pull-and-provisioning-transactions)).
It reports settled authority, not a response's staged overlay.

Search results carry `documentId` and `revision` from the document scanned.
Tool wiring moves these fields to result metadata, not model-facing search JSON.
Each result also says which `version` it came from, `draft` or `live`.

**Thread views (D14, D20).** A thread's port reads every source through its
`ThreadContextView`: each document in the version that thread's writes change
(`destination` from `domains/file-policy`), so drafted sources read the Work
draft in draft mode and everything else reads live. Drafted sources this
project stores (`isDrafted`, minus `user://`, which lives in the personal
project's manifest) also list through the project manifest, so a draft-only
create appears in `ls` and `search`. `version: "live"` on the view reads live text and the live
manifest, and never touches a draft. `read`, `search` and `ls` build their port
with the version the model named.
Plain markdown convenience reads and versioned reads share collab serialization.


## What it owns

- **Authoritative metadata catalog** — one normalized catalog beside ContextFS
  with per-scope heads, complete repeatable-read snapshots, bounded whole-commit
  replay/reset from an explicit captured head, direct children, and ID/path
  lookup. Project Manuscript entries use live-manifest membership. ContextFS
  observations fail closed when membership cannot be read, while catalog
  reconciliation aborts and preserves its last good tree. Mutation-triggered
  Manuscript reconciliation reserves an availability generation, then publishes
  the catalog commit and generation atomically after the aggregate commit; a
  failed deferred repair is retried and never publishes its reserved generation.
  `refreshProjectDocuments` takes the availability publisher fence (`reserve`)
  before any catalog scope lock, under a short `lock_timeout`, and retries a
  bounded number of times; `reserve` and `publishReserved` are required port
  methods with no non-atomic fallback. Other
  project and Work sources retain their source-specific visibility. `ContextFS` owns result-aware single-source transactions;
  `ContextTreeMover` owns full preflight-through-CAS tree transactions. Lazy
  sources and Drizzle stores join those boundaries. Wake hints run only after
  commit and cannot fail a mutation.
  Catalog replay limits are positive safe integers at HTTP boundaries and are
  defensively capped by the shared domain policy. Work catalog IDs pass through
  the canonical request-ID parser before authority resolution.

- **Namespace attempt settlement** — browser move/delete commands carry immutable
  operation IDs. `ContextOperationReceipts` locks the actor/project/operation key
  and checks its receipt before source preflight. The existing tree owner runs in
  a real savepoint; a typed rejection rolls back namespace/catalog changes before
  its outcome is recorded. Infrastructure errors remain retryable without a receipt.
  Receipt lookup requires current project access but not the old source path or
  Work. A receipt describes the historical attempt, not the document's current
  location. Replanning requires a new ID; a reused ID cannot name another command.
  Document deletion and soft project deletion preserve receipts. Hard deletion of
  their owning project or account cascades them.

- **Project-final availability** — stable-ID lookup classifies current
  project/no-Work/Work/user authority from authoritative rows and advances
  generation heads with mutations. A deleted request project or deleted backing
  source project returns `authority-unavailable/project_deleted`; restoring the
  backing project makes the same identity available again. Foreign identities
  remain indistinguishable from missing IDs.

- **Unified `ContextPort`** — single port interface (`ports/context-port.ts`)
  providing `stat`/`read`/`write`/`writeBinary`/`mkdir`/`list`/`search` for all
  schemes. Resolved through `contextPortForThread` (the resolver in
  `context-port-resolution.ts`); callers never use `forProject`/`forWork` directly.
- **Context URI primitives** — `parseUnifiedContextUri` / `toCanonical`
  normalize the six registered schemes: `manuscript`, `kb`, `user`, `unfiled`, `scratch`,
  `uploads`. Bare paths default to `manuscript://`. Work-scoped schemes
(`scratch://`, `uploads://`) carry an `@<work-slug>` wire qualifier that the
router resolves to exact project-scoped Work authority before dispatch.
- **Unified context port factory** (`unified-context-port-factory.ts`) — two deep
  modules: `context-source-provisioning.ts` (race-safe `context_sources`
  provisioning + lazy promise-cached resolution) and the factory composition root.
- **ContextPort router** (`context/router.ts`) — dispatches scheme-relative paths
  to the correct scheme adapter; attaches its resolved canonical URI to successful
  reads/writes and to `ContextError` results. Router and tree-move boundaries share the canonical
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
- **Image path adapter** (`adapters/asset-path-resolver.ts`) — implements
  collab's `DocumentAssetPaths` port. Each scope resolves its project (by
  project, document or thread) and loads every image in the project's
  manuscript, wherever it sits and including deleted ones, in one recursive
  query kept to the project's rows by the `folders_context_root`,
  `folders_parent` and `documents_context_images` indexes. Nothing is cached
  between operations, and figure upload does not notify it. ContextFS search
  binds its source document IDs to one scope, resolving their common project
  once and reusing its image snapshot across all chapters. The factory must
  receive the same asset-path port instance as collab. Paths are
  manuscript-relative; parsing accepts the bare form and `manuscript://`. A
  path held by a live image resolves to it; otherwise only a sole deleted image
  at that path claims it. Scope rules live in collab's
  [document authority notes](../../collab/.context/document-authority-and-schema.md).
- **Document-link resolver port** (`ports/document-link-resolver.ts`) — one
  resolution boundary for standard Markdown hrefs, all six canonical Context
  schemes, and relative paths. The domain reads the existing Context catalog
  and resolves Work qualifiers through project Work authority; it has no separate
  candidate loader or resolution cache. Personal scope comes from authenticated
  route identity, never from the URI.
- **Corpus import** — folded into `kb://imports/…` ingest (ceremony deleted;
  `corpus-import-service.ts` keeps slugging/dedupe/normalization helpers).
- **Browse layer scheme** (`browse-layer-scheme.ts`) — HTTP browse scheme
  vocabulary, routing, and work-scope membership gating for work-scoped schemes.
- **Result promotion** prepares exact resolved/no-Work URI identity before an
  object put. The result repository owns same-ID terminal reconciliation;
  compensation occurs only for `definitely_not_committed`, while unknown
  outcomes retain bytes and emit diagnostics.
- **Work deletion** atomically soft-deletes live Work-owned context sources,
  documents, and folders with `deletedByWorkId`. Existing catalog and
  filesystem live-row predicates hide those rows; Work restore clears only
  those marked by that deletion. Separately deleted content stays deleted.
  Upload intake metadata is retained through the 30-day restore window, then
  the projects `work-purge` job removes the Work's upload objects and rows.

## Contracts

| Contract | Shape |
|---|---|
| `ContextPort` (`ports/context-port.ts`) | Result-returning filesystem surface: `stat`, `read`, `write`, `createTrackedDocument`, `createUntitledDocument`, `ensureTrackedDocument`, `edit`, `writeBinary`, `move`, `commitWriterLocation`, identity-required `delete`, `list`, `mkdir`, and `search`. `move` preserves filesystem container-target and optional-overwrite semantics; `commitWriterLocation` is the writer exact-target, provisional-name-graduating policy. Both delegate to one location mutation. Domain failures are Results; transaction infrastructure exceptions propagate unchanged. |
| `ContextSchemeAdapter` | Scheme-local adapter over normalized paths. It never parses URIs; it returns scheme-relative paths and scope-free `AdapterFault`s. Its identity lookup lets the router recover a client-minted document across schemes. |
| `SchemeCapabilities` | Per-scheme `writable` / `searchable` / `creatable` declaration owned in `ports/context-adapter.ts` and enforced by the server router and adapters. |
| `ContextDocumentStore` | Primitive folder/document backing store for one context source, including project-wide stable-ID lookup used to classify idempotent creation retries. |
| `ContextTreeMutationStore` | Tree-aware mutation store with atomic `move`/provisional-graduation/recursive `delete`. Location tokens compare stable node/source/path fields rather than content activity timestamps. Delete results preserve every exact descendant document ID; deleting an empty folder returns none. |
| `DocumentLinkResolver` | `resolve({ projectId, userId, workId?, target, holder? })` returns one canonical Context document or `null`. A target is a discriminated `scheme` or `relative` value. Pending redirects for the exact holder/href win; requests without a holder fall back to previous locations only after a current miss. |

## Pending link redirects

Moves flush the project's certified derivations before entering the namespace
transaction. Personal moves flush every project of the owner. Failed document
derives log and retain last-good rows rather than blocking the move.

The move locks all mutated documents (moved identities plus any overwrite victim),
sorted by identity, `FOR NO KEY UPDATE`, then redirects whose holder
or target moved `FOR UPDATE`, ordered by holder and href (the worker's order). The weaker document lock
keeps journal FK insertion compatible. Address candidates use the shared
`documentAddressKey` and `matchDocumentPath`; contextual links are excluded.
Moved holders' relative links retain their pre-move target (or intended URI).
Moving a holder into `user://` respells project targets as contextual full URIs;
keeping its old relative path would incorrectly resolve inside personal space.
Existing `(source_document_id, href)` redirects win and keep their original
mover. `linkUpdate` counts newly inserted occurrences and distinct eligible
holders; archived/deleted Works and manifests do not count. A target moved into
another non-personal project cannot be named from a project holder; those
occurrences (and holders without any representable rewrites) do not count in
the receipt. The worker drops that target's redirect
without rewriting, leaving the old href visibly unresolved rather than silently
naming a different document in the holder's project. If any target is unavailable,
the worker defers the entire holder batch without rewriting, consuming, or
setting failure backoff. Restore makes it eligible on the next sweep.
A post-commit kick
is a no-op until the rewrite worker is composed; no holder content is edited
inside a move transaction.

## Browser document addresses

`document_previous_locations` is direct-to-identity bookmark and chat history. Moves capture only their file/subtree before DML and
record each vacated file path. Successful file/folder claims consume the exact
previous location. Failed inserts and rolled-back commands consume nothing.
Bootstrap uses the same store; hidden manifest identities are outside this
namespace. Project/Work restore changes availability, not file locations.

The Context command transaction receives the complete resolved scheme/Work set.
Personal User scopes first share the personal-project provisioning owner lock.
Production then acquires sorted Work lifecycle locks (through `lockSeamWorks`,
which also confirms the caller's bound edit grants) and sorted logical namespace
locks **before** source provisioning, preflight, or catalog publication. Logical
keys exist before lazy source rows; direct Drizzle stores derive the same keys
from backing ownership. Do not enter a single-source transaction and then issue
a multi-source command with a larger lock set.

Full paths can exceed the PostgreSQL B-tree tuple limit. History uses a hash
index with exact equality rechecks, and namespace-locked replacement owns
source/path uniqueness. All folder batches commit atomically. Current files or
folders suppress aliases; an alias is returned only if its stable identity is
currently available to the request owner in the requested project.

## URI and router invariants

- Wire context URIs are `scheme://[@slug]/path`; a scheme root is `scheme://`.
  Parsing validates syntax and returns `normalized`; it does not authorize a
  Work. Stable server results use the persisted slug carried by opaque,
  same-project resolved authority; explicit `@/` is no-Work authority.
- Bare paths default to `manuscript://` (project-scoped).
- Leading/trailing slashes and repeated slashes are normalized away; `.` segments
  are dropped; `..` is rejected.
- Writer-created file and folder segments cannot begin with `@` at any depth.
  The prefix is reserved for Work authority qualifiers; interior `@` characters
  remain valid.
- Work-scoped schemes (`scratch://`, `uploads://`) accept one `@<work-slug>`
  qualifier. Omitted authority resolves contextually to the thread's primary Work.
  Explicit `@/` resolves to that project's locked No Work row and serializes as
  `@/`. Every non-deleted named Work in the same project is addressable regardless
  of thread membership; cross-project Works are refused. `manuscript://`,
  `kb://`, `user://`, `unfiled://` carry no Work authority. Scratch and uploads
  are Work-scoped only.
- Strings that look scheme-prefixed but omit `//` are invalid, not bare paths.
- Scheme and relative paths are exact (an omitted final extension may match);
  relative traversal cannot escape its scheme root. Canonical qualifiers may explicitly name another
  non-deleted Work in the project. Contextual scratch/uploads use the selected
  scope; `@/` always means No Work. Legacy `work://` is not accepted.
  Archived Work identity still parses/resolves as authority and its Work-scoped
  catalog still lists its files (archive hides a Work from Active, not its
  contents) and remains an available read target. Only deleted Works hide their
  files. Zero or multiple matches both resolve to
  `null`; resolution never guesses.
- Router methods attach the resolved canonical URI to every `ContextError` and
  successful read/write result. Transport and collab callers publish that value;
  they never echo syntax-only request URIs as document identity.
- `uploads://` is intake, not an authoring workspace. F0 owns its authority,
  provisioning, and resolution; F4 owns the actual `UploadIntake` lifecycle. Tracked creation, untitled
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
  `excerpt` and, where documents serialize as hashlines (reads through a
  thread view), the `blockHash` a caller navigates by; that absence elsewhere is the
  contract. Hashline parsing lives once, in `adapters/context-fs/match.ts`,
  which scans one entry per block, matches against the body rather than the
  hash, and sends addressing and prose as separate values so nothing
  downstream has to know the format.

## ContextFS invariants

- `ContextFS` owns normalized path ↔ folder/document resolution and creates
  missing folders on writes and `mkdir`.
- Text documents are Yjs-canonical. Reads call the collab domain's
  `readAsMarkdown` directly. Writes flow through collab markdown/write APIs,
  and await the immediate certified derive hook for listing/search. ContextFS
  never republishes returned serialization. The derive transaction writes both
  projection and UTF-8 byte size from its durable cut.
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
  the document-store creation boundary independently refuses binary-to-tracked
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
  initialize-only checkpoint.
  An older row missing membership is repaired on its next tracked-document touch;
  repair seeds absent Yjs state from the row projection and preserves existing
  canonical Yjs content. Work-scoped `scratch`/`uploads` stores resolve the project
  through their Work and deliberately register in the live view, not a work-draft
  view: the ws live-room gate checks the live project manifest.
- Work-scoped source provisioning and tree/content mutations lock and recheck the
  owning Work in their transaction. Work deletion takes the same lifecycle lock,
  while read paths never provision a missing source and instead return empty/not-found.
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
- Successful HTTP deletion acknowledges `{ status: "deleted", deletedDocumentIds }`.
  Every `ContextPort.delete` caller names the expected entry kind and, for a file,
  its initiating `documents.id`; mismatch or CAS replacement is `stale_target`
  and acknowledges nothing. This is the same CAS boundary for HTTP deletion and
  internal exact-file cleanup; there is no path-only file-delete contract.
  Files contribute their one committed `documents.id`; recursive folder deletion
  contributes every committed descendant document ID, while an empty folder
  contributes none. Post-commit membership callback failure is diagnostic; the
  committed receipt remains successful.

## Deleted (cleanse removal)

- **Legacy `ContextPortFactory`** (dual-port with `forThread`/`forProject`) — deleted.
- **`fs1://`** scheme — sandbox-era vestige, removed.
- **`scratch://.results`** — promotion cruft, removed. Results use canonical Scratch paths.
- **`LegacyThreadContextPort`** / `manuscriptContextPort` / `REQUIRED_MANUSCRIPT_URI` — deleted.
- **Corpus-import domain ceremony** — folded into `kb://imports/…` ingest.

## Negative space

This slice uses generic context vocabulary. Do not reintroduce alternate auth
adapter seams, sandbox filesystem assumptions, or upstream product naming.
External connectors (google_drive/dropbox/notion) are schema-only — no
implementation. The `results://` scheme does not exist.

## Downlinks

- [Collab write codec and schema coherence](../../collab/.context/CONTEXT.md)

## Unfiled namespace

`unfiled://` is project-owned document storage, with the same ContextFS,
Yjs authority, catalog, availability and identity-preserving move operations as
Manuscript and KB. Its membership means not yet filed; a name alone does not
change that membership. It has no Work qualifier and remains accessible to
normal context tools and reference resolution.
