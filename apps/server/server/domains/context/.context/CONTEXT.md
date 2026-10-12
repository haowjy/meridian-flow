# domains/context — context filesystem primitives (unified)

Agent-readable/writable project workspace content addressed by context URIs.
A single unified `ContextPort` that resolves durable project schemes
(`manuscript://`, `kb://`, `user://`, `unfiled://`) and work-item-scoped schemes
(`scratch://@slug/…`, `uploads://@slug/…`) plus No Work Uploads at `uploads://@/` and lineage Scratch at `scratch://@/c12/`.

## Document names

`@meridian/contracts/protocol` owns basename parsing (`parseDocumentFilename`) and rendering (`renderFilename`). Prose is stored as
`name` with empty `extension` and `fileType = 'markdown'`. Input accepts and
repeatedly strips `md`, `markdown`, `mdx` and `txt`, case-insensitively. Registered
non-prose suffixes retain their lower-case extension; unknown suffixes belong to
the name. Names are trimmed and must have a nonempty stem other than `.` or `..`.
A prose stem ending in a registered non-prose suffix is `invalid_name`, with
alternatives in its message, not another spelling for that data file.

Lookups use exact parsed parts, not link extension omission. File results return
the canonical URI. Create-on-existing through `ensureTrackedDocument` reaches
the same identity for all prose spellings. Untitled documents are `Untitled N`.
`storedFilename` in contracts owns destination naming for optimistic clients,
the router and the tree mover. Commands consume its parsed parts once, preserving
the source's actual extension before target inspection and CAS. Same-identity
renames are in place. Type changes still respect the existing Yjs schema guard.

Binary storage uses `filenameForBinary` after the same parse: prose names take
the storage type's registered suffix when available, otherwise keep the parsed
name. Reads and tree inspection never guess storage kind before resolving identity.

Documents and folders cannot share document names within a parent. A folder's
comparison name is parsed by the document codec (`Lore.md` clashes with document
`Lore`); its own spelling stays unchanged. Creation, parent
provisioning and tree commits check opposite-kind occupancy under the existing
sorted logical namespace advisory locks, held through the transaction. Work
restore takes those same locks and checks the complete arriving tree before
unhiding either table. Location-only CAS tokens still fence moved identities.

## Revision queries and reads

Runtime uses the context-owned `DocumentRevisions.current` port, never collab
directly. Its adapter resolves the thread's current primary Work and the chat's write mode,
checks project-final availability, then delegates each
document to collab's effective reader. A document a re-read would not find
returns null, even when its Y.Doc remains loaded in Hocuspocus. Draft reads
pull live changes synchronously before selecting peer, Work draft, or live;
direct reads use live authority. The port may run inside a thread-locked
transaction; collab's pull transaction rules make that safe (see the
[collab contract](../../collab/.context/CONTEXT.md#pull-and-provisioning-transactions)).
It reports settled authority, not a response's staged overlay.

Search results carry `documentId` and `revision` from the document scanned, and
host-only `shown` (`SearchShowing`: the holder URI and view the read spelled
from, and each returned passage's ref-bearing links, after the passage cap),
for the host to record the passages the model received whole.
Tool wiring moves these fields to result metadata, not model-facing search JSON.
Each result also says which `version` it came from, `draft` or `live`.

**Thread views (D14, D20).** A thread's port reads every source through its
`ThreadContextView`: each document in the version that thread's writes change
(`destination` from `domains/file-policy`), so drafted sources read the Work
draft in draft mode and everything else reads live. Which documents and folders
exist is the tree view's answer (`tree/`): a drafted source's adapter has a
draft placement and resolves its view once per command with
`drafts.viewForWork` (live while the Work has no active draft; a read never
makes one), so a draft's hidden create appears in `stat`, `read`, `ls`,
`search` and `locate` in that draft only. `version: "live"` reads the live tree
and live text, and never touches a draft. `read`, `search` and `ls` build their
port with the version the model named.

**Creates by placement (contract §6).** The port factory decides each adapter's
placement once (`placementFor`); ContextFS delegates to that strategy
(`adapters/context-fs/create-placement.ts`). A draft placement's
`ensureTrackedDocument` and `writeBinary` make (or, for text, join) a hidden row
through the `DraftCreatePort` (`drizzle-draft-creates.ts` over
`tree/creates.ts` and `tree/end-use.ts`, with collab's branch half injected) in a command
transaction that locks the drafting Work, ensures and locks its draft
(`runInDraft`), then takes namespace keys. Whole-file writes, creates with text,
untitled creates and `mkdir` refuse in a draft placement: a draft never seeds
live Yjs. The in-memory port is explicitly live-only.

The live create pipeline is `adapters/context-fs/live-create.ts`. A live create
at a hidden document's or folder's path reveals it instead of inserting a twin;
with content it discovers the candidate holding nothing, takes its live lease,
and admits the content on a clone inside the reveal's transaction
(`writeCollabMarkdownHeld`), applied to the warm room after commit. Create by id
(`revealDocumentId`, link Create on an "in a draft" link) reveals only a hidden
document of this project, locking its physical source; the identity lookup is
project-scoped and never needs the destination source to exist. Any other id
conflicts and never mints. `documentId` is a mint (an upload's reservation, an untitled
create's client id). `retractCreate` reverses a create for a rolled-back reply
or a failed create write: the router deletes a live create; a draft placement
ends the draft's use unless another thread's committed text makes it stand, and
collab deletes that Work's draft branch and its peers, then retires exactly those
peers' rooms and thread state; another Work's peers on a shared hidden document
are untouched.

**End of use (contract §12).** A hidden node no active draft uses is tombstoned,
never left live. `tree/end-use.ts` (collab's Discard and Work purge's disposal, a
retracted create) and the create pickers tombstone it under its document lock,
release its storage (live Yjs, every branch on it, derived rows, its own link rows)
and prune emptied hidden folders bottom-up; a picture's object is deleted after
commit. Every end of use locks through `acquireEndUseScope` (namespaces of the
sources read, a re-read, then documents; a moved scope aborts and rediscovers).
Reads repair what a bug left: `identityStatus` answering gone for a hidden, live,
unused node schedules `tree/hidden-node-repair.ts` after the read, in its own
transaction behind that scope, as tracked detached work; a create's candidate
picker reports its own repair. Each is a `context.hidden-node.repaired` warn event
after commit. Compose wires one repair into the link scope, the mover's link count
and every create path (`hiddenNodeRepair` on the port factory). A draft create holds
its source's namespace every command, not only when provisioning resolves it.
Plain markdown convenience reads and versioned reads share collab serialization.


## What it owns

- **Authoritative metadata catalog** — one normalized catalog beside ContextFS
  with per-scope heads, complete repeatable-read snapshots, bounded whole-commit
  replay/reset from an explicit captured head, direct children, and ID/path
  lookup. `invalidate-subtree` clears the cached root and descendants; the same
  commit re-upserts every authoritative survivor from the union of old and new
  affected subtrees, including unchanged entries and children moved out of the
  root. Never rely on a separate repair to restore visibility. An absent root
  means the subtree is gone from this scope, not pending refetch.
  Entries are the live tree view (`visibleDocuments(LIVE_TREE)`,
  `visibleFolders(LIVE_TREE)`): a draft's hidden rows and folders never reach
  it. Source refreshes (`refreshSources`) publish in the mutating transaction;
  Apply's draft tree step and the Discard kernel reconcile their sources that
  way too, so there is no post-commit catalog refresh for drafts.
  Other project and Work sources retain their source-specific visibility.
  `ContextFS` owns result-aware single-source transactions;
  `ContextTreeMover` owns full preflight-through-CAS tree transactions. Lazy
  sources and Drizzle stores join those boundaries. Wake hints run only after
  commit and cannot fail a mutation.
  Catalog publication compares entries without their stamps. A to B to A still
  republishes: a move or delete names its node as an invalidation root, so the
  return re-upserts the entry with the newer stamp.
  Availability and namespace versions are separate. `advance` moves only the
  availability generation (an authority-only change such as a Work's state is not
  a namespace change); `publishNamespace` allocates a namespace observation
  version, and only a change to a live file, folder or source calls it. One
  `reconcileScopes` call stamps every scope it changed with one version. Stamps
  are lower bounds: an entry is at least as new as its stamp, and one stamp can
  cover several changes, so order by stamps but never read one as naming a change.
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
  project/lineage/Work/user authority from authoritative rows and advances
  generation heads with mutations. A deleted request project or deleted backing
  source project returns `authority-unavailable/project_deleted`; restoring the
  backing project makes the same identity available again. Foreign identities
  remain indistinguishable from missing IDs. The same lookup accepts exact folder
  IDs, returning canonical folder entries or independent tombstones. Folder
  tombstones retire namespace refresh work, never descendant document content;
  reversible Work/lineage hiding remains authority unavailability. The optional
  internal `view` reads draft locations; omitted means live. Hidden rows outside
  the view are missing, documents and folders alike.

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
  the markdown write API directly. There is no host edit or append door: a
  host changes a document by writing it whole (or the model edits it through
  agent-edit).
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
  one chapter cannot disturb another that references the same asset. Signed URL
  reads default to live; the additive `?workId=` resolves that Work's draft view
  for both file authorization and figure identity.
- **Document-link scope adapter** (`adapters/document-link-scope.ts`) —
  implements collab's `DocumentLinkScopes` port. Each snapshot resolves its
  project, owner and personal project once (by project, document or thread)
  and then loads only what each `prepare` names, skipping keys it already
  holds: an ahead ref's meanings, rows by id, and every row at an exact or
  extension-omitted address (in a draft view, also whatever that draft has
  at the exact address). Each view (`live` or `draft:<draftId>`) reads the
  tree view's `identityStatus`: where a document sits in that view, and for
  a hidden one, `presence: "draft"` with the draft it reads "in a draft" in
  (the reader's own if it uses it, else the oldest active one) and that
  draft's path; a document that draft created is an ordinary occupant only
  in its own view. An ahead ref reads, per holder, the holder's own binding
  (`link_ahead_holder_bindings`, written by Apply), then the view's draft
  settlement, then the live settlement; a reader door with no holder reads the
  last two. `holderBinding` exposes the first, for copies (§10.6), and
  `pinHolder` names the holder a reader door reads bindings for, only one the
  reader may name and read by the catalog's rule (an id alone is no capability). Readability
  comes from the file policy's `listAccess`, a hidden row's facts from the
  draft it reads in. Images are documents: the `asset:` rule reads the same
  rows. Nothing is cached between operations. ContextFS search binds its source document IDs to one snapshot;
  each chapter's read prepares its own document into it. The factory must
  receive the same scope instance as collab. Scope rules live in collab's
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
| `ContextPort` (`ports/context-port.ts`) | Result-returning filesystem surface: `stat`, `read`, `write`, `createTrackedDocument`, `bindTrackedDocument` + `createBoundDocument`, `createUntitledDocument`, `ensureTrackedDocument`, `writeBinary`, `move`, `commitWriterLocation`, identity-required `delete`, `list`, `mkdir`, and `search`. `move` preserves filesystem container-target and optional-overwrite semantics; `commitWriterLocation` is the writer exact-target, provisional-name-graduating policy. Both delegate to one location mutation. Domain failures are Results; transaction infrastructure exceptions propagate unchanged. |
| `ContextSchemeAdapter` | Scheme-local adapter over normalized paths. It never parses URIs; it returns scheme-relative paths and scope-free `AdapterFault`s. Its identity lookup lets the router recover a client-minted document across schemes. |
| `SchemeCapabilities` | Per-scheme `writable` / `searchable` / `creatable` declaration owned in `ports/context-adapter.ts` and enforced by the server router and adapters. |
| `ContextDocumentStore` | Primitive folder/document backing store for one context source, including project-wide stable-ID lookup used to classify idempotent creation retries. |
| `ContextTreeMutationStore` | Tree-aware mutation store with atomic `move`/provisional-graduation/recursive `delete`. Location tokens compare stable node/source/path fields rather than content activity timestamps. Delete results preserve every exact descendant live document ID (a draft's hidden contents split off first and are never named); deleting an empty folder returns none. A move is the overwrite victim, then `tree/node-moves.ts`'s `moveNodes`. |
| `DocumentLinkResolver` | `resolve({ projectId, userId, workId?, target, previousLocations? })` returns one canonical Context document or `null` for a ref-less address. A target is a discriminated `scheme` or `relative` value. Only chat (`previousLocations`) falls back to previous locations, and only after a current miss. |
| `LinkAheadRegistry` | `register` (throws `UnregistrableAheadRefError` for a ref it refuses for good: malformed id, an address `resolveCanonicalAddress` can never resolve, an id already registered elsewhere; independent root transaction: each named draft `FOR SHARE`, then namespace keys only; with a `draftId`, idempotent per (ref, draft), so a ref already registered still settles on the draft's single occupant when it has no live settlement), `settleArrivals` (inside the arrival's locked transaction, no lock), `registerUnregistered` (anti-join recovery of client mints, one page in ahead-id order, one ref at a time, failures logged; returns the last key attempted on a full page). |
| `DocumentArrivals` | Arrival hooks over the registry: `lockNamespaces` (namespace-only keys of documents' sources) and `settle`. |

## Live folder operations and hidden nodes

A draft's hidden rows stay where that draft placed them whatever the writer
does to live folders (`tree/folder-normalization.ts`). A rename or move that
lands a folder at a hidden folder's path absorbs it; a recursive delete, or a
folder move to a source fewer drafts may hold (another project, out of `user://`
into a project, or into a Work-owned or lineage Scratch source; see
`tree/draft-ownership.ts`), first splits hidden contents into hidden twins at
their old paths. Otherwise they move with the folder, and the change rows under
it take the new source. History (vacated
aliases, consumed claims) is written for visible nodes only; every moved,
deleted or overwritten node's `location_version` is bumped once.

## Moves and the link note

A move writes nothing into any holder: links carry `doc:`/`ahead:` refs and
re-spell on read. Moves flush the project's certified derivations before
entering the namespace transaction (personal moves flush every project of the
owner); the flush also registers client-minted ahead refs, so every certified ref
is registered before the move takes namespace keys. Failed derives and failed
registrations log and never block the move.

Inside the transaction the move row-locks every mutated document (moved
identities plus any overwrite victim), sorted, `FOR NO KEY UPDATE`
(`lockMovedDocumentRows`). The weaker lock keeps journal FK insertion compatible
while ordering the move against derive certification. After all DML and history
the new source row determines project membership. The move settles ahead refs at the
destinations once (a folder move settles against its final tree), then
`countIncomingLinks` sums `document_links` occurrences whose `doc:` ref names a
moved document or whose `ahead:` ref is settled on one, from live content holders
in the request project. Hidden draft holders are excluded by the live tree view. A moved holder's own links to unmoved documents are not
counted; personal and other-project holders are not counted. The receipt shape
stays `linkUpdate: { links, documents }`.

## Whole-document writes

`ContextFS.write` and `createTrackedDocument` with content (the layer is
`context-fs/bound-writes.ts`)
bind their Markdown (`documentSync.bindMarkdown`) **before**
`commandExecutor.run`, then apply the `BoundWrite` inside the
namespace-locked transaction (collab `document-authority-and-schema.md`). The
existing document is looked up outside the transaction for that; the
transaction looks it up again and checks the bound write was made for what
occupies the path now; if the occupant changed, it answers `stale_target`
and nothing is written. The bound write is desired state: it overwrites what
the document holds when it applies, like any whole-document save. An actor's
overwrite binds against the current document; import and system
writes bind fresh. A new document binds as the canonical URI it will have
(`ContextFSDeps.holder`: the port's project and the source's Work authority).

A caller that creates inside its own transaction binds first:
`ContextPort.bindTrackedDocument`, then `createBoundDocument` with the
bound write. Upload intake does this (`UploadContentPort.bind` runs
before finalize's transaction, `persist` applies under its locks).
Binding is preparation, not creation: it checks only that the scheme is
writable. Both tracked-create doors (`createTrackedDocument`,
`createBoundDocument`) pass the caller's origin and ask the source's one
`requireCreation` policy (`intake` when a document id is supplied, else
`entry`); that is what refuses writer creation into a lineage. Never move the
creation check to bind time or add a second lineage-creation guard downstream.

A live create's identity, content and arrival commit in one aggregate, so no
half-created document exists to repair; a visible row is used as it is.

## Ahead refs and arrivals

`link_ahead_refs` records each `ahead:` ref with the decoded address it was
minted for (project, scheme, Work id or lineage root id, path; owners by id, so
a rename never orphans it). Lineage registrations and arrivals compare the root id
as well as the exact path; two chats cannot capture each other’s waiting refs. Rows are never deleted by link edits. Server mints register before
the write takes any lock; client mints are registered by the certified derive
(awaited outside a transaction, after commit inside one), and the derivation
sweep and `flush` recover any that failed with `registerUnregistered`. A soft-deleted
Work keeps its identity (slugs stay reserved), so a ref to its address registers
and waits for the restore.

An ahead ref settles on the first live document at its exact address, by
compare-and-set on `settled_document_id IS NULL`; a later occupant never captures
it. Arrival hooks, each once against the operation's final tree:

| Arrival | Where | Locks already held |
|---|---|---|
| Tracked create (named, untitled, model create/copy, import) | creation aggregate, after content initialization | command transaction's namespace keys |
| Binary upload, figure upload | `createBinaryDocument`, after persisting the live identity in the same transaction | the store transaction's namespace keys |
| Move-in (file, overwrite, folder) | tree store, once after all DML | every participating namespace |
| Work restore | after unhiding, with the hidden documents' namespace keys taken before any row reappears | thread forest → Work → namespaces |
| Draft Apply (warm and recovery) | the draft tree step's `afterAdmission`, once for every reveal, restore and relocation of the batch | Work → draft → current and final namespaces → document locks |

A draft's hidden create is no arrival: it settles unsettled refs at its address
in the draft only (`link_ahead_draft_settlements`). A reveal is an arrival at
the creator's path, through the creation aggregate. Deleted rows are not
arrivals.

What a ref means in a draft has one writer, `adapters/link-ahead-draft-settlements.ts`,
which owns the policy (a ref takes a draft's meaning only while it has no live
settlement, and keeps the first one) and the registry's address predicate: a
draft's create settles the refs waiting at its address, a registration with a
`draftId` settles each ref on the draft's single occupant (the registry keeps
its root transaction and locks and calls in), and closing a draft or ending its
use of a create drops what it meant. Refs in
a draft's text register with its id: an agent's mint carries its holder's view
(`AheadMint.view`); a writer's link typed in the review room registers after the
room admits it, debounced; and Apply's prerequisite registers every ref in the
branches it publishes before staging (collab's `draft-branch-ahead-registration.ts`).
Apply binds each published holder's refs (`link_ahead_holder_bindings`, one
writer: `adapters/link-ahead-holder-bindings.ts`) from the meanings it staged,
read at staging through `draftMeaningsOf`; a binding is never deleted, and one
naming a tombstone reads gone.

`adapters/document-address.ts` owns server document addresses: the canonical
address a document's folder chain spells now, a canonical address resolved to
storage coordinates (project, scheme, Work, No Work lock coordinate, path), the
document at an exact address (rendered path compared byte for byte). A document under a deleted folder reads as deleted
at its address. The link scope, the ahead-ref registry, the move note, and the
browser address lookup all read through it.

## Browser document addresses

`document_previous_locations` is direct-to-identity bookmark and chat history. Moves capture only their file/subtree before DML and
record each vacated file path. Successful file/folder claims consume the exact
previous location. Failed inserts and rolled-back commands consume nothing.
Bootstrap uses the same store. Project/Work restore changes availability, not file locations; Work
cascade delete and restore nevertheless advance document/folder location versions.

The Context command transaction receives the complete resolved scheme/Work set.
Personal User scopes first share the personal-project provisioning owner lock.
Production then acquires sorted Work lifecycle locks (through `lockSeamWorks`,
which also confirms the caller's bound edit grants) and sorted logical namespace
locks **before** source provisioning, preflight, or catalog publication. Logical
keys exist before lazy source rows; direct Drizzle stores derive the same keys
from backing ownership. Do not enter a single-source transaction and then issue
a multi-source command with a larger lock set.

Ahead-ref registration uses the exported `lockNamespaceKeys` seam when it opens
its independent root transaction. It takes only the sorted, deduplicated logical
namespace keys: no Work lifecycle or holder lock is acquired. Arrival settlement
runs in the caller's already-locked transaction and acquires no lock, so the
Work → namespace → holder order used by authored moves and creates cannot form a
cycle with registration.

Full paths can exceed the PostgreSQL B-tree tuple limit. History uses a hash
index with exact equality rechecks, and namespace-locked replacement owns
source/path uniqueness. All folder batches commit atomically. Current files or
folders suppress aliases; an alias is returned only if its stable identity is
currently available to the request owner in the requested project.

## URI and router invariants

- Wire context URIs are `scheme://[@slug]/path`, plus `scratch://@/cN/path` for
  a lineage; a scheme root is `scheme://`.
  Parsing validates syntax and returns `normalized`; it does not authorize a
  Work. Stable server results use the persisted slug carried by opaque,
  same-project resolved authority; explicit `@/` is no-Work authority except
  on Scratch, where it must be followed by a first-chat handle.
- Bare paths default to `manuscript://` (project-scoped).
- Leading/trailing slashes and repeated slashes are normalized away; `.` segments
  are dropped; `..` is rejected.
- Writer-created file and folder segments cannot begin with `@` at any depth.
  The prefix is reserved for Work authority qualifiers; interior `@` characters
  remain valid.
- Work-scoped schemes (`scratch://`, `uploads://`) accept one `@<work-slug>`
  qualifier. Omitted authority resolves contextually to the thread's primary Work.
  Uploads `@/` resolves to the locked No Work row. Scratch `@/c12/` resolves
  to the first chat of a project-local lineage, including a trashed first chat.
  Scratch `@/x` without a handle is refused with contextual and canonical hints. Every non-deleted named Work in the same project is addressable regardless
  of thread membership; cross-project Works are refused. `manuscript://`,
  `kb://`, `user://`, `unfiled://` carry no Work authority. Scratch and uploads
  use named-Work owners; No Work Scratch instead uses the lineage owner.
- Strings that look scheme-prefixed but omit `//` are invalid, not bare paths.
- Scheme and relative paths canonicalize the final name through the document codec.
  Exact names win; only without an exact match may exactly one non-prose file
  match with its final extension omitted;
  relative traversal cannot escape its scheme root. Canonical qualifiers may explicitly name another
  non-deleted Work in the project. Contextual scratch/uploads use the selected
  scope; a lineage handle is part of the owner, so relative traversal cannot
  cross it. Bare Scratch in a No Work chat selects its lineage. Legacy `work://` is not accepted.
  Archived Work identity still parses/resolves as authority and its Work-scoped
  catalog still lists its files (archive hides a Work from Active, not its
  contents) and remains an available read target. Only deleted Works hide their
  files. Zero or multiple matches both resolve to
  `null`; resolution never guesses.
- Router methods attach the resolved canonical URI to every `ContextError` and
  successful read/write result. Transport and collab callers publish that value;
  they never echo syntax-only request URIs as document identity.
- Intake parses filenames through the document-name codec before reserving a URI.
  Prose uploads read bytes through the same tracked Markdown path regardless of
  their typed prose suffix. Original filenames remain in intake metadata and
  import provenance; collisions use the shared smallest ` (2)` allocator.
  Corpus conversion removes only its DOCX source suffix before using the codec;
  imported titles and directories retain their spelling. Atomic creation refuses
  replacement if another intake claims the allocated name. Whole-batch planning
  reserves folder names and desired document names before numbering; already-
  canonical source names win, then source filename order determines allocation.
  Response items remain in input order. Identity-bound uploads accept one file
  per request; only corpus intake accepts multi-file and relative-path batches.
- File output uses `exportFilename`: prose gains `.md` from persisted `fileType`;
  all other documents retain their stored filename. Download headers encode
  Unicode names, and binary document downloads serve bytes with that filename.
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
- Contextual sources pair each adapter with its canonical owner, resolving lazily
  when needed. Bare resolution, root listing and unscoped search use that same
  set, including the chat's Scratch whether owned by a Work or lineage.
- Mutation resolution binds a creation policy from owner, actor and scheme
  capabilities. Entry creation and intake both enforce it; existing-content
  writes and same-owner renames are not creation. Untitled allocation and
  writer location commits remain writer seams.
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
  boundary: it atomically allocates `Untitled N` under the Document names
  contract (past live documents and live folders' document aliases), persists
  `provisionalName`, and installs an empty Yjs authority in one
  transaction. The client owns initial CRDT content; this path must never seed
  non-empty markdown. Router-level retries locate the ID
  (`ContextPort.locate`, the same scan) across every project scheme and authorized
  Work authority and return
  `already-materialized` with the actual canonical scheme/path/Work. This is
  distinct from a true allocation conflict. Response `name` is always the full
  basename including extension. A successful basename change clears the flag in
  the shared tree-mutation store, while path-only moves preserve it.
- Production text creation commits the context row and initial Yjs authority/content
  together. Warm-room publication follows commit. Reads and listings use the selected
  SQL tree view. Draft creation records a hidden live identity and the draft's tree use,
  and never seeds live Yjs. Scratch and uploads are live Work-owned rows; the live-room
  gate checks their tree identity and access, with no registration or repair step.
- Work-scoped source provisioning and tree/content mutations lock and recheck the
  owning Work in their transaction. Work deletion takes the same lifecycle lock,
  while read paths never provision a missing source and instead return empty/not-found.
  so it cannot commit between authorization and a new scratch/upload mutation.
- Cross-source moves preserve document identity. The destination row determines
  project visibility; no separate membership state moves. The move commit must not
  rewrite document Yjs authority or journal rows.
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
- Writer moves may carry `destinationParent` (folder ID or qualified area root).
  Folder identity is resolved in the move transaction before namespace lock
  selection, then again under those locks. A change of namespace while locking
  returns `stale_target` rather than acquiring locks in a new order. Parent
  tokens fence the durable mutation; picked-parent moves never create folders. Absent, terminal and denied destinations return
  `destination_missing`. Linked creation may carry `createFolders`, a validated name suffix beneath the
  identity anchor. The move verifies the anchor before ensuring that suffix and
  filing in the same transaction. A missing anchor creates nothing. Ordinary
  picked-parent moves have no suffix. The receipt records both alongside the
  original command, and successful identity moves return their committed URI.
  HTTP confirms edit on the resolved destination under its namespace locks.
  URI-addressed moves retain path-based folder creation.
- Successful HTTP deletion acknowledges
  `{ status: "deleted", deletedDocumentIds, availabilityGeneration }`.
  Every `ContextPort.delete` caller names the expected entry kind and, for a file,
  its initiating `documents.id`; mismatch or CAS replacement is `stale_target`
  and acknowledges nothing. This is the same CAS boundary for HTTP deletion and
  internal exact-file cleanup; there is no path-only file-delete contract.
  Files contribute their one committed `documents.id`; recursive folder deletion
  contributes every committed descendant document ID, while an empty folder
  contributes none.

## Negative space

This slice uses generic context vocabulary. Do not reintroduce alternate auth
adapter seams, sandbox filesystem assumptions, or upstream product naming.
External connectors (google_drive/dropbox/notion) are schema-only — no
implementation. The `results://` scheme does not exist. Neither Recent list
lives here: chat Recent (documents this chat touched) reads
`turn_document_touches` in `threads`; the project's recently opened list is
`domains/recent-documents`.

## Downlinks

- [Collab write codec and schema coherence](../../collab/.context/CONTEXT.md)

## Unfiled namespace

`unfiled://` is project-owned document storage, with the same ContextFS,
Yjs authority, catalog, availability and identity-preserving move operations as
Manuscript and KB. Its membership means not yet filed; a name alone does not
change that membership. It has no Work qualifier and remains accessible to
normal context tools and reference resolution.

Markdown projections live in `document_markdown_projections`, not tree identity rows.
Stores batch-read them through `readProjections` only when list word counts are requested.
Text creation inserts the projection in its identity transaction; binary creation does not.

## Lineage Scratch ownership

`scratchOwnerFor` is shared by thread routing and the file policy's own-Scratch
term. Named Works own Scratch; No Work chats use their persisted `rootThreadId`.
A fork and subagents share notes; a handoff starts a fresh lineage. Source rows
carry project plus root identity, not a Work. Provisioning is lazy on the first
AI write and refuses an unassigned first-chat handle. No Work bootstrap only
provisions Uploads.

There is no thread FK on `context_sources.root_thread_id`. Trash reconciliation
keeps notes while any lineage member is live, hides the source with the last
member, and restores it with any member. It refreshes catalog and availability
truth in the same transaction through the composed catalog mutation port.
First-write provisioning and trash/restore share the Scratch namespace lock
and any-live-member predicate; policy exposes the same liveness even before a
source exists. Identity lookup by ID or handle allows trashed first chats,
while `ls scratch://@/` discovers only available notes and labels each lineage
with its first chat’s title. Its entries have independent edit decisions.
`GET .../context/lineages/:rootThreadId` (`lineages.byId`) gives the app the
same handle and title, trashed first chat included, so writer chrome can name a
lineage whose first chat has left the live chat list.
Work purge explicitly removes sources for roots
in its purge set, including their documents, journal and memberships.

Writer routes can read, edit, rename or move notes out, but cannot create notes
or move files into a lineage. Canonical AI writes use the normal edit policy.
Rebinding selects a different bare Scratch owner; it never moves notes. The
durable Work-switch Notice names the previous canonical Scratch root.

Creation conflicts carry `occupantKind` (`file` or `folder`) through ContextError
and HTTP error data; it is absent when the failure cannot prove an occupant.


## Browser review address admission

Ordinary browser addresses resolve only in the live tree. The address request
may carry a review selector (`reviewWorkId`, `draftBranchId`, optional
`documentId`). The server matches that branch and canonical path against the
Work's active review items before selecting the whole draft's `TreeView`.
The URL's `draft=` and selector branch are per-document branch IDs, never
tree draft IDs. Candidate and identity availability reads use that same view,
and the final read grant names the draft destination. Stale, foreign, or
mismatched selectors answer unavailable without falling back to live. Mutation
inspection still defaults to `LIVE_TREE`.
