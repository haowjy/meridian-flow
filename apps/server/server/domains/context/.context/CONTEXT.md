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
owned by `@meridian/contracts/protocol`; exact parsed names win before any
extension-omitted lookup. Documents and folders share one namespace: a folder's
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
`createTrackedDocument`, `createTrackedDocumentAtFreeName`, `createBoundDocument`
or `ensureTrackedDocument`. The free-name command owns allocation, identity and
initial content together; callers supply only batch reservations and use its
authoritative URI.

## Grep

`ContextFS.grep` (scan in `adapters/context-fs/grep-scan.ts`, matching in
`grep/matcher.ts`) lists a source's documents once, asks the caller's `readable`
before matching or counting anything, and walks them in path order until
`headLimit` files have matched. Patterns are RE2 (`re2js`, linear time) matched
per line of the document's grep text: markdown as `read` shows it, link
destinations spelled empty, decoded to the text view. A document with usable
stored text is matched from it, and read only when its passages are wanted;
every hit is confirmed per line, because the whole-text prefilter can match
across a line break. Past the limit, fast-path documents are still counted and
documents that need a read are not, so the total becomes "at least N".
The first match's offsets in the shown excerpt are stored on the passage
(`anchor`), and the model-facing window cuts there.

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
the identity read adds the retained Markdown projection. Both authorize
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
in the live view, then resolve it again under namespace locks; stale plans
return `stale_target`, while an occupied destination leaf sends the arrival to
the next alias-aware free name and returns that actual path. An absent,
terminal, or denied identity destination returns `destination_missing`.
Location-only CAS tokens fence moves and deletes. A `createFolders` suffix is
validated beneath the identity anchor in the same transaction; a missing
anchor creates nothing. Folder deletes validate the supplied folder identity
before recursive mutation. Every `ContextPort.delete` names the expected entry
kind and, for a file, its initiating document id; a mismatch or replacement is
`stale_target` and acknowledges nothing. There is no path-only file delete.
Work deletion soft-deletes its owned sources, documents, and folders marked
`deletedByWorkId`; restore clears only those, so separately deleted content
stays deleted.

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

## Document content and filetype rules

`ContextFS` resolves filetype before constructing Yjs content. Existing text
uses persisted classification; path-driven filetype changes happen only in a
location commit within the same tracked schema. Document/code or tracked/
binary conversion is refused until an explicit conversion seam exists.
Unknown suffixes remain tracked prose; registered non-tracked types fail with
a typed error. Binary creation and upload use the binary storage path and do
not erase storage or MIME metadata through a text write.

Text writes route provenance through `collab-document-sync.ts`: agent writes
carry turn identity, human writes carry user identity, and omitted provenance
is system-originated. The document engine's immediate durable derivation feeds
projection and byte size from the same cut; ContextFS does not republish a
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
