# domains/context — context filesystem contracts

This page holds the cross-module contracts for URI resolution, ContextFS,
tree views, arrivals, and catalog publication. It deliberately omits adapter
inventories; code owns those details. The [entry page](../AGENTS.md) lists the rules to
know before editing.

## URI and ownership

The unified `ContextPort` resolves `manuscript://`, `kb://`, `user://`,
`unfiled://`, `scratch://`, and `uploads://`. Bare paths default to
`manuscript://`. Owners are named by handle, flat after `@`: `scratch://@w3/` is a Work's
Scratch, `uploads://@c12/` a chat's uploads (bare `uploads://name` is the
asking chat's; the Work owns none), and `scratch://@c12/` the No Work chat
lineage rooted at its first chat. `owner-lookup.ts` is the one answer to who
owns a handle or a near-miss name, shared by errors, receipts and `ls scratch://@`.
Parsing normalizes syntax but does not authorize a Work. Cross-project or
foreign authorities remain unavailable, and the legacy `work://` scheme does
not exist.

`skills://` is model-only skill loading and has no documents. Callers resolve
through `contextPortForThread`; they do not choose scheme adapters directly.
Membership selects a thread's primary Work but does not grant access. The
named Work or No Work lineage is the owner of bare Scratch, and the locked No
Work row never owns Scratch. A fork and its subagents share a lineage; a
handoff starts a new one. Writer routes may read, edit, rename, or move notes
out of a lineage, but may not create notes or move files into one.

URI paths reject `..`, normalize slash segments, and reserve a leading `@` in
writer-created names for authority qualifiers. Canonical filename parsing is
owned by `@meridian/contracts/protocol`. Every tree lookup of a typed name asks
`addressCandidates` (literal, then the codec's alias), and whatever holds the literal name
answers whatever its kind: `TreeReader.resolveAddress` is the one tree walk over them,
`matchDocumentAddress` and the client catalog's `findPath` the same order over a list. A caller
that wants a document (`read`, a link, a document address) asks `resolveDocumentAddress` or
`resolveDocumentAt`, which skips a folder and tries the alias. Only a link may also leave a registered extension off (`outline` for
`outline.json`): `matchDocumentPath` adds that unique-match step after the address, and no
`stat`, route or other tree lookup does. A binary write carries its decided name parts
(`ContextWriteBinaryOptions.filename`), so a copy's name is parsed once. Naming asks the row's kind
(`storedFilename` with `{ extension, editable }`): a stored file keeps its literal name, a tracked
document follows the alias rules, and a move with no typed name keeps the token's `name` and
`extension` without parsing. Documents and folders share one namespace by
literal name: a folder clashes with a document when the folder's name equals the
document's rendered filename (folder `binary.md` beside a kept `binary.md`), and
two folders or two documents clash the same way. Folder `Lore.md` and document `Lore`
coexist; a link to `Lore.md` still reaches the document, because a document lookup skips the folder,
while a path that names a folder acts on the folder: `ls` lists it and a reorder moves it. The model's `move` and `delete` refuse it with `source_is_folder`.
A free name is chosen by the list's writer against its own copy of the tree
(`@meridian/project-tree`), never by a reader. A node's `name` in `tree_nodes` is its filename as
shown, extension included; readers never render a filename from a name and an extension.

## Access, source capabilities, and transactions

File policy decides whether a caller may read or edit and whether an agent
write is live or drafted. Context asks that policy before mutation. Storage
transactions begin with the complete resolved Work set, lock user/project
provisioning where needed, then take sorted Work lifecycle and logical
the list's lock and then namespace keys before source provisioning, preflight or DML. Source locks and document locks follow the caller's established order;
never add a larger lock set after entering a single-source transaction.

`lockSeamWorks` confirms bound edit grants and holds Work lifecycle rows.
Context seams repeat their own active-Work check because replay, derivation,
and lifecycle-owned writes may have no grant scope. A root transaction that
registers an ahead ref takes only sorted namespace keys. Arrival settlement
runs in the already locked caller transaction and takes no new lock.

Work-scoped source provisioning and mutations lock and recheck the owning Work
in their transaction; read paths never provision a missing source and return
empty or not-found. Whole-document writes bind before the namespace-locked
transaction (`stale_target` if the occupant changed). Binding is preparation,
not creation: the source's single `requireCreation` policy is the only
lineage-creation guard, so never move it to bind time or add a second one.

Scheme capabilities are declared in `ports/context-adapter.ts`. Uploads
authority is separate from `UploadIntake`: uploads are flat
binary intake, while Scratch is the writable authoring space and accepts
nested paths. Text creates and writes resolve the persisted filetype and call
collab's document-aware engine; they never seed a Y.Doc with an assumed
Markdown schema. Binary documents are storage-backed and are read through
storage, not the text engine. A whole-file `write` overwrites a living document and
answers `not_found` at an empty path: it never creates (W52); creation is
`createTrackedDocument`, `createBoundDocument` or `ensureTrackedDocument`.

## Grep

`ContextFS.grep` (scan in `adapters/context-fs/grep-scan.ts`, the pattern and
passages in `grep/matcher.ts`, the threads in `grep/match-pool.ts` and
`grep/match-worker.ts`) lists a source's documents once, asks the caller's `readable`
before matching or counting anything, and walks them in path order until
`headLimit` files have matched. Patterns are RE2 (`re2js`, no backtracking, but
time still grows with text times program size, and one call can't be interrupted) matched in worker threads, so a slow pattern ends by termination at the deadline and never blocks the
event loop. `compileGrep` only validates on the main thread (RE2's own refusals, 512 characters); there is no
static size limit, since program size doesn't measure cost. The pool starts threads on demand up to 4
and keeps them; each serves one request at a time and compiles the pattern it is sent (cached by it), so a
terminated thread loses only the request that ran there. With all four busy, further requests queue, each
for no longer than its own signal. The built server emits the worker as `workers/match-worker.mjs`
(`bundleWorkerEntries` in `apps/server/nitro.config.ts` rewrites `new URL("./x.ts", import.meta.url)`);
vitest and `tsx` run the `.ts` file directly. The pool is shared by the process, so four concurrent
slow greps (one user's four chats, say) hold every thread for up to 20 s; anyone else's grep queues,
spends its own budget waiting, and returns stopped and empty. No per-user cap exists yet.
Matching is per line of the document's grep text: markdown as `read` shows it, link destinations spelled empty, decoded to
the text view (a code file's text is the file itself, with no fence). Each document's text comes first: collab's `readStoredGrepTexts`
answers which of a slice of 50 documents have stored text matching what this reader
sees (current derivation, no active draft in the reader's own Work, no staged writes of
the reply), else the effective read's blocks give it. Collab's `readStoredWordCounts` is the
same door for `ls -v`: it answers for current derivations only, and a document it leaves out
lists with no word count. Context never reads the block tables itself. Candidate paths are spelled through
the tree view's folder chain; a document under a deleted ancestor has no path and is not
searched. One loop over the text decides
match and count; the read is repeated only for `content` mode's passages. A
case-insensitive pattern first needs its required literal
(`grep/required-literals.ts`) to appear. Past the limit, documents with stored text
are still counted and documents that need a read are not, so the total becomes
"at least N" (`exact: false`). The scan stops
on the handler's abort signal (the caller leaving, or a 20 s budget), which also terminates
the matching thread mid-call, returning what it found with `exact: false, stopped: true`. A passage stores its first match's offsets in
the shown excerpt (`anchor`; the model-facing window cuts there) and the matched
writer text (`term`; the app's door finds the passage again with it).


## Views, identity, and revisions

The tree module supplies `LIVE_TREE` and `{ kind: "branch", branchId }`. ContextFS
uses that view for `stat`, `read`, `list`, `grep`, and `locate`; a branch's
document or folder that exists only in that Work's draft appears only there. A draft create has an
empty live Y.Doc and text in its draft until Apply. Readers compose `visibleDocuments(view)` and
`visibleFolders(view)` ([tree](../tree/AGENTS.md)); there is no hidden row to filter.

`DocumentRevisions.current` resolves the thread's current primary Work and the
chat's write mode, checks project-final availability, and delegates effective
document reads to collab. A `version: "live"` request uses live text and the
live tree; a draft request uses the selected Work's branch tree and the document's draft. The port
may run inside a thread- or Work-locked transaction, subject to collab's
independent pull transaction rules. It reports settled authority, not a
response's staged overlay.

A project-final identity lookup distinguishes missing, deleted, and
reversibly hidden authority; foreign identities stay indistinguishable from
missing IDs. Lineage hiding is authority loss rather than
file deletion, so cached Scratch resources can return when a live lineage
member or Work is restored. Document tombstones and lineage-hidden sources
retain distinct status. Stable IDs never become capabilities without a policy
check.

`DocumentTrash` owns the deleted-document lifecycle outside live `ContextPort`
path resolution. List and identity reads admit only a currently restorable
delete: visible rather than hidden, not removed by a Work cascade, unpurged,
and still under a live source and project. The list returns removal metadata;
the identity read adds the document's Markdown, serialized from its frozen Yjs on request. Both authorize
through the project before exposing the tombstone or its text. The hourly
purge releases content after the shared 30-day retention period while keeping
the tombstone and incoming identity links. It takes the Work, branch,
namespace, document, and draft locks before rechecking eligibility. Pending
branch text or tree changes defer purge; otherwise collab closes active drafts
before the storage-release kernel erases the content.

## Writes to the tree

Every write of the tree is records made at the call through `treeListStore.submit({ list, make })`
([the list store](tree-list-store.md)): ContextFS creates, moves, renames, deletes, copies and uploads,
and the model's tree tools. `make` runs under the list's lock in the command's transaction, reads
the list's replay (final names and paths come from it, never from a read before the lock) and returns
the records, ONLY those that create new nodes claim ids. One command is one `submit`. Lock order:
Work lifecycle rows, the list's key, then namespace keys (an arrival settling ahead refs), then
document keys; a caller holds no document or namespace key when it submits. `context-fs/tree-writes.ts`
(`SourceTree`) is the one place ContextFS makes records.

- **Placement.** People and auto-apply chats write live (`LIVE`). A draft-mode chat on a drafted
  source writes the Work's branch (`{ draft: branchId }`); the command transaction ensures and
  locks the branch (`runInBranch`). Scratch content writes stay live in draft mode, while its tree
  writes are drafted, so one drafted move can cross Scratch and a drafted source. A draft never
  seeds live Yjs: whole-file seed is a live-only command.
- **Create.** The record, the document's first Yjs state and its arrival are one unit
  (`documentCreation.createDocumentAtomically`; `live-create.ts`). An occupied name refuses with
  `conflict`; a create never replaces or joins another document. A draft create also makes the
  document's draft (`ensureCreatedDocumentDraft`).
- **Move and rename.** One `move` record; `move` with `keep` renames or reorders in place. A
  move writes no document bytes. A destination name taken by another node answers `conflict`.
  A move between a project and the account (`user://`) crosses two lists and is refused
  (`invalid_operation`) until `submit` can take two lists.
- **Delete.** One `delete` record: the node and its subtree go to Trash together; the result
  lists every document and file the cascade took. `onlyAt` (a model create's retraction) acts only
  while the node still stands at that path, otherwise `stale_target`. A drafted delete is a
  branch record and leaves live alone.
- **Retraction.** `retractCreate` reverses a create whose write failed: live goes to Trash, drafted
  is discarded when the document's draft holds nothing else.
- **Edit history.** The model's tree entry (`recordAgentTreeChange`) is written in the same
  transaction through `inTransaction` / `afterWrite`; a drafted write reports the branch and the
  node's facts on either side (`drafted`).

There is no untitled create, provisional name, hidden row, forward, operation receipt, folder
table or catalog refresh: the replay is the only tree, and readers see it through the view.

## Copy

A Copy is one atomic command per drop: ordered roots (documents and folders) into one
destination folder, with an optional sibling position.
`POST /api/projects/:projectId/context/copy` and `./mf doc copy` drive it; the browser's
Copy intent is not built yet. The pieces: `copy/copy-port.ts` resolves the request's
addresses to adapters, `copy/copy-command.ts` reads, duplicates and orchestrates, and
`adapters/context-fs/copy-adapter.ts` (source read) with `copy-tree.ts` (insertion) is what
one source's tree contributes.

- Each source tree is listed once (`ContextCopyAdapter.snapshotSource`, live tree) and each
  tracked document's content is read once as a frozen cut (`readEffectiveBlocks`: the live
  document, or the draft a tab shows when the source names that view). The listing is a
  series of committed reads, not one database snapshot; a folder moved while it runs lands
  on one side of it. A selection collapses to its outermost roots first: a root inside
  another selected folder, or selected twice, is already in that copy. Everything slow
  happens before the command's transaction opens: the reads, a binary's duplicated object (`prepareBinaryCopy`: a
  store-side `copy`, never through memory), the plan, and the binding. A source room that is not open
  loads through a second connection, so a transaction held across the reads would starve
  the pool. Each put key is released if no transaction commits to name its object (a
  refusal, a retryable failure, a replay that never reads it). A process crash between a put
  and the rollback still leaks it (the model copy tool leaks the same way; one storage sweep
  would cover both).
- The command transaction (`commandTransaction.run`) takes the destination's Work and, through
  `treeListStore.submit`, its list. The sources are a frozen cut, so their lists are not locked
  and a source deleted mid-copy is a copy of what the writer saw. The command re-resolves an
  identity destination through the router's one resolver (`destination_missing` when the
  folder is gone, `permission_denied` when the writer cannot edit it), then the destination
  adapter inserts the plan (`copyInto`) as one `submit`.
- Names are the destination namespace's, so its adapter plans them (`planCopy`): allocated
  against live occupants and the rest of the batch, from a lock-free read of the destination
  parent ([naming conflicts never
  block](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/placement-and-naming.md#naming-conflicts-never-block)).
  Only the roots meet existing occupants.
  A selected root may carry the device's `copyId` (a UUID); the root copy takes it and
  every descendant keeps a server-minted identity. A node id already taken (`NodeIdRefusedError`
  from the list store's claim) makes the insert a typed `conflict`; a replay is not recognised
  as one until the server keeps document commands; a duplicate id
  within one request is a 400. The plan mints every identity before any content is bound,
  so one old→new map binds links between roots through `collab/domain/copied-blocks.ts`: links inside the copied set name
  the copies (a settled `ahead:` ref, an unsettled one whose address now holds a copied
  folder, and an image or link to a copied binary included),
  everything else keeps its target. The model's `copy` tool calls the same
  `remapCopiedBlocks`, with the same settled-ahead map read from the same cut, so a document
  it copies and a document a writer copies point their links alike. The model remaps a
  document onto its own copy only when it copied the whole document, never an excerpt.
  Under the lock `copyInto` re-reads the parent and confirms the roots would take the same
  names; if a concurrent write took one, it inserts nothing and answers `replan`, and the
  command plans and binds again under the lock (a second plan cannot move).
- A copied folder's children arrive in source order, so its visible order survives. Roots
  arrive at the end of the destination parent. An explicit position places the roots as one
  run: the first there, each next one after the previous.
- Content is bound for the address each copy will have (`bindCopiedBlocks`, a fresh holder,
  so it lands only in an empty document) and encoded to its first Yjs state
  (`encodeSeed`) outside the lock. The insert is one `submit` of `create` records
  (`SourceTree.insertTree`, ranks from `generateNKeysBetween`); the creation aggregate
  (`createDocumentsAtomically`) persists the identities, `InitialDocumentSeeds` writes the heads and
  seed checkpoints, and every arrival settles once, so ahead refs pointing at a copy's new address
  settle. Projections and link rows are derived after the transaction commits, four documents at a
  time (`refreshDocumentProjection`), and the answer does not wait for them: a successful answer
  means the rows are committed, not derived. A derivation that fails is logged and the stale sweep
  recovers it. `metadata.copiedFrom` records the source URI, the version read and that version's
  revision.
- Refusals are typed: `not_found` or `stale_source` for a gone or changed source,
  `destination_missing` for a destination that no longer exists, `stale_target` for one that
  moved, `permission_denied` for an identity destination the writer cannot edit,
  `invalid_operation`
  for a folder into its own subtree ("Can't go inside itself", the drag hint's words), an
  unsupported source (a draft view of a folder, or of a document its Work holds no draft of:
  reason `no_draft`), the source root, or a draft placement destination. Uploads as the
  destination (by path or by folder identity), a malformed path or state vector, and a vector
  sent for a folder are refused by the route before the domain runs, typed and unrecorded. A
  draft view names its Work and no chat: the server reads that Work's active branch's draft of
  the document, and a Work outside the project is refused as `work_missing`.
- A client-held source sends its Yjs state vector with a document source (a folder source
  with a vector is a 400). The vector is compared with the room of the view being read, live
  or draft. When the cut lacks updates it names, the read waits up to 2 s for the room to
  catch up, then answers `io_error` with `reason: "source_behind"` ("The source has edits the
  server has not received yet"): retryable and never recorded, so the replica's replay
  reads the room again, and distinct from a transport failure so the
  replica can stop after a bounded wait. A live document's vector from a real tab has been checked; no draft
  tab has sent one yet, so confirm the draft room's vector against one first.
- A document that exists only in a Work's draft is not in the live tree, so it cannot be a
  source yet (`not_found`).
- There is no Undo command: Copy's Undo is ordinary deletion of the identities it created.

## Catalog and publication

The catalog tables and the catalog read endpoint stay; the server no longer writes them. The
catalog is a view of the replay, not a second visibility policy, and no write refreshes it.

Move and delete are addressed by entry id: the router takes the node (`{kind, nodeId}`) and an
area; the area only decides which adapter to ask. The adapter finds the node in the list's replay
inside `make` (`SourceTree.move`, `delete`), so a rename or move by another writer in the gap is
neither undone nor refused; the only facts it checks are about the target (the occupant, `onlyAt`,
the source the caller found the node in). A node that left the source answers `stale_target`. A move
with no `name` keeps the node's name and one with no destination keeps its folder. A move to an
occupied name answers `conflict`.

## Document content and filetype rules

`ContextFS` resolves filetype before constructing Yjs content. Existing text
uses persisted classification; path-driven filetype changes happen only in a
location commit within the same tracked schema. Document/code or tracked/
binary conversion is refused until an explicit conversion seam exists.
Unknown suffixes remain tracked prose; registered non-tracked types fail with
a typed error. Binary creation and upload use the binary storage path and do
not erase storage or MIME metadata through a text write. `writeBinary` takes
`hasPreview`: the caller stores the original and its preview first
(`saveImagePreview`, [storage](../../storage/.context/CONTEXT.md#previews)).
Reads sign the original for download and answer `drawUrl`, what to draw:
the preview, the original when browsers draw that type, or nothing (the file
card). `drawObjectKey` in storage is the one place that decides it.

Text writes route provenance through `collab-document-sync.ts`: agent writes
carry turn identity, human writes carry user identity, and omitted provenance
is system-originated. The document engine's immediate durable derivation feeds
block rows and byte size from the same cut; ContextFS does not republish a
returned serialization. Cross-source moves only change tree identity and
classification metadata allowed by the schema guard.

## Links, arrivals, and addresses

Stored links carry stable `doc:`, `folder:`, or `ahead:` refs; image sources use
document refs only, while Markdown carries none. The link scope resolves refs
against the selected tree view and current availability, and the codec spells
relative links from the holder's current URI. Folder identities resolve to
their current canonical URI and spell with a trailing slash.
Moves and renames therefore do not rewrite document content. An ahead ref is a
path until an arrival claims it; once a document arrives, settlement binds the
ref through the final tree. Every tracked create, upload, move-in, Work
restore, and Apply settles arrivals once in its completion transaction. A ref
binds once, to the first live document at its exact address, for every holder:
a later occupant never captures it, nothing rebinds it, and a paste copies it
as is. A branch's hidden create and a deleted row are no arrival. Lineage
registrations compare the root id as well as the path, so two chats cannot
capture each other's waiting refs; a soft-deleted Work keeps its identity, so
refs to its address wait for restore. Refs in a draft's text register globally
and best effort (an agent's mint, a link typed in the review room, and Apply's
prerequisite for the drafts it publishes); a failed registration never fails
Apply. The context link-scope adapter must receive the same scope instance as
collab, whose [document authority notes](../../collab/.context/document-authority-and-schema.md)
hold the scope rules.

Zero or multiple matches resolve to `null`; resolution never guesses. An
archived Work still resolves as authority and lists its files (archive hides a
Work from Active, not its contents); only deleted Works hide theirs.

A ref-less address resolves in its typed scope; only chat falls back to a
document's previous locations, and only after a current miss. Personal scope
comes from authenticated route identity, never from the URI. Moves record each
vacated path in `document_previous_locations`, so bookmarks and chat history
reach the document by identity; an alias returns only when that identity is
currently available to the request owner in the requested project.

A link resolver is not a capability. A reader who cannot reach a ref receives
`gone` without a location. A document that exists only in the reader's Work draft answers `inBranch` with that branch and
path; another Work's draft-only document is not shown to the reader. Holder binding is stable by document identity, and
relative spelling uses only a holder the reader may name and read.

Browser addresses normally resolve in the live tree. A review address may
supply `reviewOwner` (a draft owner key) and an item key `${branchId}:${documentId}`; the server
checks that item against active review items, then reads the branch tree, except
for a drafted delete whose identity is intentionally absent there, which reads
the live tree by the validated document identity. The branch's view decides whether the item's
document is shown: one the Work's tree no longer shows reads as deleted there. Stale,
foreign, or mismatched selectors return unavailable rather than falling back
to live. The address resolver returns the canonical current locator; it never
makes a path-only URL a capability.

## Lineage and special namespaces

Lineage Scratch sources carry project and root-thread identity, not a Work.
Provisioning is lazy on the first AI write and shares the Scratch namespace
lock with trash/restore liveness. The source remains while any lineage member
is live, hides when the last member leaves, and restores with a live member.
The first chat may be trashed and still names its lineage; `ls` lists only
available notes. A lineage root names Scratch ownership, never a reader: draft
visibility for link answers comes from the selected Work's branch tree view, so
never pass `rootThreadId` as the viewing thread. Rebinding a chat selects a
different bare Scratch owner and never moves notes; the durable Work-switch
Notice names the previous Scratch root. Work purge explicitly removes lineage sources in its purge
set, with documents, journals, memberships, and blobs.

`unfiled://` is project-owned storage with the same ContextFS, Yjs authority,
catalog, availability, and identity-preserving move rules as Manuscript and
KB. Its membership means not yet filed; a name does not change membership.

## Negative space

External connectors (google_drive, dropbox, notion) are schema-only. There is
no `results://` scheme. The project's recently opened list doesn't live here:
it is `domains/recent-documents`.

## Downlinks

- [Context tree visibility and lifecycle](../tree/.context/CONTEXT.md)
- [Upload intake](../uploads/.context/CONTEXT.md)
- [File access policy](../../file-policy/.context/CONTEXT.md)
- [Collab codec and authority](../../collab/.context/CONTEXT.md)
- [Deferred work](FUTURE.md)

## Import reveal

An import stages nothing in tables of its own: each planned text is written to the document journal under the id its node will have, and the reveal (`adapters/drizzle-import-reveal.ts`) is one `submit` of `create` records for every planned node, in the transaction that finishes the import. The writer's `createAll` numbers each name against the list as it stands at the reveal (a name taken since the plan is renumbered), ranks the top level after what the destination folder holds and a new folder's children in name order, and the store derives the `documents` rows from the records. A destination folder deleted meanwhile stands again (the replay). Then the reveal writes the properties and previews the records do not carry, registers ahead refs under the namespace keys they settle, and settles the arrivals.

