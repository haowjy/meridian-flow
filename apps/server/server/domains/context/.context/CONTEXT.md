# domains/context — context filesystem contracts

This page holds the cross-module contracts for URI resolution, ContextFS,
tree views, arrivals, and catalog publication. It deliberately omits adapter
inventories; code owns those details, while [the parent entry page](../AGENTS.md)
provides the cold-start mental model.

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
owned by `@meridian/contracts/protocol`. Every lookup of a typed name asks
`addressCandidates` (literal, then the codec's alias, then the extension omitted);
`TreeReader.resolveAddress` is the one tree walk over them, and `matchDocumentPath` and the
client catalog's `findPath` the same order over a list. Naming asks the row's kind
(`storedFilename` with `{ extension, stored }`): a stored file keeps its literal name, a tracked
document follows the alias rules, and a move with no typed name keeps the token's `name` and
`extension` without parsing. Documents and folders share one namespace: a folder's
comparison name uses the document-name codec, so `Lore.md` occupies the
`Lore` document alias.

## Access, source capabilities, and transactions

File policy decides whether a caller may read or edit and whether an agent
write is live or drafted. Context asks that policy before mutation. Storage
transactions begin with the complete resolved Work set, lock user/project
provisioning where needed, then take sorted Work lifecycle and logical
namespace locks before source provisioning, preflight, catalog publication, or
DML. Source locks and document locks follow the caller's established order;
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
hidden document or folder appears only in that branch. A draft create has an
empty live Y.Doc and text in its draft until Apply. The hidden predicate has
one owner in [tree](../tree/AGENTS.md); callers never inspect hidden columns.

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

## Creation and hidden-node lifecycle

Content placement and branch tree visibility are separate. Scratch content writes stay live in
draft mode, but its adapter reads through the Work's branch and can record branch tree changes.
This lets one drafted move cross between Scratch and a drafted source: the branch view shows the
document at its proposed destination while both live sources remain unchanged until Apply. Uploads
remain read-only. Placement is chosen once per command. Live create can reveal a hidden node at
its path instead of inserting a twin and admits text on a clone before warm
room publication after commit. Draft placement creates or joins a hidden row
and records its branch use; whole-file seed, `mkdir`, and other live-seeding
operations are not draft operations. A client-minted untitled ID is idempotent
across authorized project and Work schemes; retries return the materialized
canonical location rather than allocating another document. That path installs
an empty Yjs authority and never seeds non-empty Markdown: the client owns the
initial CRDT content. The writer's
instant create is never refused for a name: a branch's hidden text document at
that path is unhidden and keeps its id, the device's minted id forwards to it
(`document_forwards`, answered `joined`, and link resolution follows forwards for
ids no document holds), and a visible occupant sends the create to the first
free name. `retractCreate` reverses a create for a rolled-back reply or failed
write: a draft placement ends the branch's use unless another thread's committed
text makes the document stand, and only that Work's document draft, peers, and
rooms retire.

A device-minted folder ID is idempotent the same way (`createFolderIfAbsent`, the
`create-folder` route): a replay finds the folder under its ID and answers
`already-exists`. The route reads the ID first (`answerHeldFolder`), before any authority
over the destination, so an ID held out of reach (deleted, hidden, foreign, a document's) is a
final `409 conflict` even when the destination's Work is archived. The folder takes the
first free name at the destination and absorbs a hidden branch folder already there, so a
create is never refused for a name. A destination that is gone is `destination_missing`.
A create carries `destination.position` like a document create, resolved under the move
lock; an anchor the server does not hold leaves the folder at the parent's end.

A hidden node with no active branch use is tombstoned, never left live. End of
use locks and rechecks the complete namespace/document scope, releases its
storage and drafts, and prunes empty hidden folders. A moved scope aborts
and rediscovers. Read-time repair may schedule the same end-use operation but
must not silently change the read result. Work restore checks the complete
arriving tree before unhiding it.

Cross-source moves preserve document identity and never rewrite Yjs content or
journal rows. A move writes no document bytes. It flushes the project's
certified derivations (which also registers client-minted ahead refs) before
entering the namespace transaction, and failed derives never block it. Inside
the transaction it row-locks every mutated document `FOR NO KEY UPDATE`, never
`FOR UPDATE`, so journal FK inserts stay compatible. Its receipt counts incoming
links (`linkUpdate: { links, documents }`) from live content holders in the
request project only: hidden draft holders, personal and other-project holders,
and a moved holder's own links to unmoved documents are not counted. A live
folder rename or move that lands on a hidden folder's path absorbs it (never
refused); a recursive delete, or a move to a source fewer branches may hold,
first splits hidden contents into hidden twins at their old paths, so a
writer's live folder operations never disturb a branch's hidden rows. Identity moves resolve a folder
in the live view, then resolve it again under namespace locks. The mover finds the
moved row by id under the locks and builds the destination there: the leaf is
`change.name` or the row's own, the folder is the row's own (`keep`), a folder read by
id (`folder`), or an address (`at`, a root or the model's typed folder, which
`createFolders` may extend). No path of the node reaches the mover from outside, so a rename or move
by another writer in the gap is neither undone nor refused; the only paths it checks
are facts about the target (the occupant, `onlyAt`). A row that left the locked Work or area answers a non-final
`io_error` (`namespace_changed`) and the caller looks it up again; `stale_target`
from a move now comes from the destination-leaf CAS or a stale sibling anchor. An
occupied destination leaf sends the arrival to the next alias-aware free name and
returns that actual path. A delete with `onlyAt` (a model create's retraction) acts
only on a row still at that path and otherwise answers `stale_target`. An absent,
terminal, or denied identity destination returns `destination_missing`.
Location-only CAS tokens fence moves and deletes. A `createFolders` suffix is
validated beneath the identity anchor in the same transaction; a missing
anchor creates nothing. Folder deletes validate the supplied folder identity
before recursive mutation. Every `ContextPort.delete` names its node and an area root
URI (adapter and locks only); a row that is gone is `not_found`, and with `onlyAt` one
that has left the place is `stale_target` and acknowledges nothing. There is no
path-addressed delete. A refusal's `uri` names the area, not the entry.
Work deletion soft-deletes its owned sources, documents, and folders marked
`deletedByWorkId`; restore clears only those, so separately deleted content
stays deleted.

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
  happens before the receipt's transaction opens: the reads, a binary's duplicated bytes
  (`prepareBinaryCopy`, D24), the plan, and the binding. A source room that is not open
  loads through a second connection, so a transaction held across the reads would starve
  the pool. Each put key is released if no transaction commits to name its object (a
  refusal, a retryable failure, a replay that never reads it). A process crash between a put
  and the rollback still leaks it (the model copy tool leaks the same way; one storage sweep
  would cover both).
- The operation receipt (`kind: "copy"`) owns the transaction. Inside it the command
  transaction takes the destination's Work and namespace, and nothing else: the sources are
  a frozen cut, so their namespaces are not locked and a source deleted mid-copy is a copy
  of what the writer saw. The command re-resolves an identity destination through the
  router's one resolver (the one Create and Move also use: `destination_missing` when the
  folder is gone, `permission_denied` when the writer cannot edit it), then the destination
  adapter inserts the plan (`copyInto`).
- Names are the destination namespace's, so its adapter plans them (`planCopy`): allocated
  against live occupants and the rest of the batch, from a lock-free read of the destination
  parent. A hidden draft node never takes a name from a copy ([naming conflicts never
  block](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/documents/naming/naming-conflicts-never-block.md)):
  the insert normalizes the roots' names, so a hidden node on a root's name yields to the next
  free one. Only the roots meet existing occupants.
  A selected root may carry the device's `copyId` (a UUID); the root copy takes it and
  every descendant keeps a server-minted identity, so a replay or a replan keeps the roots
  the client already names. Any row already holding a `copyId` — live, hidden, deleted, in
  another source, or a document's — makes the insert a typed `conflict`; a duplicate id
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
- A copied folder keeps its source's order policy and its children arrive in source order,
  so a manual folder's visible order survives. Roots arrive by the destination parent's own
  rule (the end of a manual parent, name order in a default one). An explicit position
  places the roots as one run: the first there, each next one after the previous, so a
  default parent becomes manual exactly as a reorder makes it.
- Content is bound for the address each copy will have (`bindCopiedBlocks`, a fresh holder,
  so it lands only in an empty document) and encoded to its first Yjs state
  (`encodeSeed`) outside the lock. The insert is set-based, because nothing below a root can
  meet an occupant: `ContextDocumentStore.insertNewTree` writes folders, documents,
  projections and claimed locations in one statement per batch of 500 (`tree/new-tree.ts`),
  `InitialDocumentSeeds.seedInitialDocuments` writes the heads and seed checkpoints, and the
  creation aggregate (`createDocumentsAtomically`) settles every arrival once, so ahead refs
  pointing at a copy's new address settle. The per-node checks of a single create (occupancy,
  hidden candidate, hidden-name yield) are skipped on purpose: they are what makes a
  create cost fifteen statements, and the plan has already allocated around every name.
  Projections and link rows are derived after the transaction commits, four documents at a
  time (`refreshDocumentProjection`), and the answer does not wait for them. So a successful
  answer means the rows are committed, not derived: until they fill, a model `ls` word count
  and backlinks miss the copies, and a ref the copy itself owns (`ahead:`) registers then.
  Reading a copy through its room shows its text immediately. A derivation that fails is
  logged and the stale sweep recovers it. `metadata.copiedFrom` records the source URI, the
  version read and that version's revision; folder provenance lives in the receipt.
- Refusals are typed and recorded on the receipt, so a replay under the same operation ID
  answers the same result: `not_found` or `stale_source` for a gone or changed source,
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
- A duplicate request with the same operation ID waits for an in-flight prepare in this
  process before reading, then answers from the receipt the first attempt recorded (or
  prepares itself when that attempt recorded none). Another process still re-prepares; only
  a committed receipt is shared.
- A client-held source sends its Yjs state vector with a document source (a folder source
  with a vector is a 400). The vector is compared with the room of the view being read, live
  or draft. When the cut lacks updates it names, the read waits up to 2 s for the room to
  catch up, then answers `io_error` with `reason: "source_behind"` ("The source has edits the
  server has not received yet"): retryable and never recorded, so the replica's replay under
  the same operation ID reads the room again, and distinct from a transport failure so the
  replica can stop after a bounded wait. Recording it as `stale_source` would hand the first
  answer to every replay. A live document's vector from a real tab has been checked; no draft
  tab has sent one yet, so confirm the draft room's vector against one first.
- Lock hold grows with the statements, not with a round trip per document: 200 linked
  chapters of about 1,500 words hold the destination namespace for about 0.3 s in a fresh
  project. What is left is the catalog reconcile (`refreshSources`), which reads the whole
  project scope on every write and runs twice when the destination folder is also created,
  and the head lock it takes (see `FUTURE.md`).
- A document that exists only in a Work's draft is not in the live tree, so it cannot be a
  source yet (`not_found`).
- There is no Undo command: Copy's Undo is ordinary deletion of the identities the receipt
  lists.

## Catalog and publication

The catalog is a live tree view, not a second visibility policy. Branch-hidden
rows and folders never enter it. `ContextFS` owns single-source transactions;
`ContextTreeMover` owns full preflight-through-CAS tree transactions. Apply's
tree step and the Discard kernel reconcile every affected source inside their
completion transaction. Refreshes publish authoritative survivors and moved
children in the same mutation transaction; wake hints are best-effort and
post-commit.

Availability generations and namespace observation versions are separate. A
lifecycle or authority change may advance availability without changing a
path. A live file, folder, or source change publishes a namespace observation;
versions are lower bounds, not identifiers for one particular change. A move
or delete invalidates the affected root and re-upserts current survivors, so a
move away and back still publishes the newer observation. An absent
invalidated root means the subtree is gone from that scope, not pending
refetch, and the catalog never names a hidden node, even as a root.

Operation receipts make browser move/delete attempts idempotent. The receipt
key is locked before source preflight; typed domain refusal rolls back tree and
catalog DML before recording the outcome, while infrastructure failure stays
retryable. A reused operation ID cannot replan a different command. Receipt
lookup needs current project access, not the old path or Work.

Move and delete are addressed by entry id. `ContextTreeMover` takes the node
(`{kind, nodeId}`, at the id it has now) and an area, and finds its row under the namespace
locks (`inspectNode`); the area only decides which adapter and locks to take. A row found in
another Work or area than the one locked, or a destination folder that now resolves to another
scope, answers a non-final `io_error` with `reason: "namespace_changed"`: no receipt is recorded and
the resend relocates the entry and authorizes again. The receipt command is a function of the
request alone (`expected` with the id the request carried, `destinationParent`, `position`, and
`name` only when the writer typed one). The route builds it once (`moveCommand`, `deleteCommand`)
and passes it as `operation` beside the node, so a resend is recognised without locating anything; the address lives in the result
(`destinationUri`, and `uri` on a delete), and the observation version reads its generation from it
(`user://` uses the user's counter). A move with no `name` keeps the row's name and one with no
`destinationParent` keeps its folder.

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
`gone` without a location. A hidden document may answer `inBranch` with the
selected branch and path. Holder binding is stable by document identity, and
relative spelling uses only a holder the reader may name and read.

Browser addresses normally resolve in the live tree. A review address may
supply `reviewWorkId` and an item key `${branchId}:${documentId}`; the server
checks that item against active review items, then reads the branch tree, except
for a drafted delete whose identity is intentionally absent there, which reads
the live tree by the validated document identity. The item's own draft admits its document the way it admits writes
(`survivingDraftDocuments`, availability's `admitDrafts`): a no-effect draft of a
document deleted live is not listed, so its path finds it gone, but its review
address still opens the open tab's draft (D79). Stale,
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
no `results://` scheme. Neither Recent list lives here: chat Recent reads
`turn_document_touches` in `threads`, and the project's recently opened list is
`domains/recent-documents`.

## Downlinks

- [Context tree visibility and lifecycle](../tree/.context/CONTEXT.md)
- [Upload intake](../uploads/.context/CONTEXT.md)
- [File access policy](../../file-policy/.context/CONTEXT.md)
- [Collab codec and authority](../../collab/.context/CONTEXT.md)
- [Deferred work](FUTURE.md)

## Import staging

`context_staged_folders` and `context_staged_documents` are private generation-tagged rows. Catalog, ContextFS, address lookup, link resolution, and tree readers do not read them. Reveal validates the whole placement, locks Works before namespace keys, inserts the generation set-wise, settles membership and arrivals, then publishes one catalog refresh. A changed destination refuses the generation rather than revealing a partial tree.

The reveal inserts rows unranked, then places the stage's top level like any other arrival (`placeArrivedBatch` in `tree/sibling-order.ts`): a default destination leaves them unranked, a manual one appends them after its last rank in default order, with server-minted ranks under the namespace lock it already holds. Everything below the top level sits in new default-order folders.

Both write paths that insert rows in bulk take their ranks from the same rule, `arrivalRanks` in `tree/sibling-order.ts`: `placeArrivedBatch` updates rows a caller already inserted, and `insertNewTree` (a Copy's result) writes the ranks in with the rows. A write path that inserts `folders` or `documents` rows must place them through `arrivalRanks`; setting `rank` by hand bypasses the allocator.
