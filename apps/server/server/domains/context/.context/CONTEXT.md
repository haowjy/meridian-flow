# domains/context — context filesystem contracts

This page holds the cross-module contracts for URI resolution, ContextFS,
tree views, arrivals, and the sources query. It deliberately omits adapter
inventories; code owns those details. The [entry page](../AGENTS.md) lists the rules to
know before editing.

## Agents locations

Agent files are documents. `agents://` is a project source and the folder `user://.agents/` is the
account's; `packages/contracts/src/agents/location.ts` is the one place that spells those
addresses (`agentsLocationOf`, `agentsRootOf`), so a different layout changes it and provisioning.
A file created there is a `source` document (code text, `x.md` keeps its suffix), chosen once at
create by `documentFilenameAt`; every later naming path follows the stored kind (`storedFilename`,
the project tree's `shownName` take the filetype). A client that creates a node itself (`./mf doc put`, the app)
states the kind in its create record. A prose document or a stored file at an Agent path is read
as a problem, not as an Agent (`adapters/agent-level-files.ts`, whose text cache is keyed on the
document's `content_seq`: every save of its Live room moves it); Copy keeps the source's kind, so a
prose document copied there reads as unavailable until phase 3 converts it.

## URI and ownership

The unified `ContextPort` resolves `manuscript://`, `kb://`, `user://`,
`unfiled://`, `scratch://`, `uploads://` and `agents://`. Bare paths default to
`manuscript://`, bar two aliases models are trained on: `~/x` is `user://x` and `.agents/x` is
`agents://x` (`formatParsedContextUri` is the one serializer and spells the Agents levels `.agents/x` and `~/.agents/x`, so every address a model or writer is shown or stored has one spelling). Owners are named by handle, flat after `@`: `scratch://@w3/` is a Work's
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
owned by `@meridian/contracts/protocol`. A path is a list of segments: a node's name, or for a
later twin its name, `~` and the start of its id (`Kael~b21c`, project-tree rule 14), so every
path reaches one node. The relations and the placed nodes expose `segment`; whatever spells or
walks a path uses it, whatever shows a title uses `name`, and `readSegment` is the one reader of a
typed segment. Every tree lookup of a typed name asks
`addressCandidates` (literal, then the codec's alias), and whatever holds the literal name
answers whatever its kind: `TreeReader.resolveAddress` is the one tree walk over them,
and the client's `TreeView.findPath`/`findFolder` the same walk over its replay (`childAtSegment`). A caller
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
while a path that names a folder acts on the folder: `ls` lists it and a reorder moves it.
No writer picks a free name: a name may repeat in a folder, and replay gives every later twin a
`~` suffix from its id (rule 14 in `@meridian/project-tree`). A node's `name` in `tree_nodes` is its filename as
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
collab's document-aware engine; they never seed a document with an assumed
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
event loop. `compileGrep` only validates on the main thread (RE2's own refusals); the 512-character
cap is the model `grep` tool's input schema, so another caller of `ContextPort.grep` has no limit.
There is no
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
sees (current derivation, no active draft in the reader's own Work), else the effective read's blocks give it. Collab's `readStoredWordCounts` is the
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

The tree module supplies `LIVE_TREE` and `{ kind: "draft", draftId }`. ContextFS
uses that view for `stat`, `read`, `list`, `grep`, and `locate`; a draft's
document or folder that exists only in that Work's draft appears only there. A draft create's text is
its own Live room, which only the draft's view shows; a draft's edits to a document Live has are
its fork room (`fork:<draft>:<document>`). Readers compose `visibleDocuments(view)` and
`visibleFolders(view)` ([tree](../tree/AGENTS.md)); there is no hidden row to filter.

`DocumentRevisions.current` resolves the thread's current primary Work, asks file access
(`listAccess`) for each document's decision, and delegates effective document reads to collab at
that decision's destination: a live document reads live, a draft destination reads the Work's
draft, whatever the chat's mode. A document the thread can't read has no revision. The port
may run inside a thread- or Work-locked transaction, subject to collab's
independent pull transaction rules. It reports settled authority.

`ProjectContextAvailabilityPort.placed` answers where this project (or the writer's own
User area) holds documents and folders in a view, read from `visibleDocuments`/`visibleFolders`.
A node in Trash, in a hidden or deleted source, Work or project, or in a foreign source is absent,
and foreign ids are indistinguishable from missing ones. Lineage hiding is authority loss rather than
file deletion, so cached Scratch resources return when a live lineage member or Work is restored.
Stable IDs never become capabilities without a policy check.

`DocumentTrash` owns the deleted-document lifecycle outside live `ContextPort`
path resolution. List and identity reads admit only a currently restorable
delete: visible rather than hidden, not removed by a Work cascade, unpurged,
and still under a live source and project. The list returns removal metadata;
the identity read adds the document's Markdown, serialized from its retained room on request. Both authorize
through the project before exposing the tombstone or its text. The hourly
purge releases content after the shared 30-day retention period while keeping
the tombstone and incoming identity links. It takes the Work, draft,
namespace, document, and draft locks before rechecking eligibility. Pending
draft text or tree changes defer purge; otherwise collab closes active drafts
before the storage-release kernel erases the content.

## Writes to the tree

Every write of the tree is records made at the call through `treeListStore.submit({ lists, make })`
([the list store](tree-list-store.md)): ContextFS creates, moves, renames, deletes, copies and uploads,
and the model's tree tools. `make` runs under the lists' locks in the command's transaction, gets one
`ListWriter` per list, reads the list's replay (final names and paths come from it, never from a read
before the lock) and records the changes through that writer; what it returns is the caller's own
read-back. Only records that create new nodes claim ids. One command is one `submit`. Lock order:
Work lifecycle rows, the list's key, then namespace keys (an arrival settling ahead refs), then
document keys; a caller holds no document or namespace key when it submits. `context-fs/tree-writes.ts`
(`SourceTree`) is the one place ContextFS makes records.

- **Placement.** People write live (`LIVE`), and so does an auto-apply chat in a place whose AI access
  is auto-apply. A chat whose write mode is draft, or whose place asks for review, writes a drafted
  source to the chat's draft (`{ draft: draftId }`; the owner is set in both modes and
  `sourceDestination(writeMode, scheme, owner)` decides); the command transaction ensures and
  locks the draft (`runInDraft`). A port built with a `destination` (a person's write, an Undo, a
  tool call holding its grants) places every write there and ignores the chat's mode. Scratch content writes stay live in draft mode, while its tree
  writes are drafted, so one drafted move can cross Scratch and a drafted source. A draft never
  seeds Live text: whole-file seed is a live-only command.
- **Text reads take the document's destination.** A document's address scheme is where it was found;
  a draft move can leave its content in another source. Grep's `readable` returns each document's
  decision (`level` and `destination`) and ContextFS reads each text there; the model's read tool
  reads at its grant's destination, and `keptDraft` asks the grant's `contentScheme`. The per-source
  decider (`sourceDestination` in `placementFor` and `ContextFS.threadView()` with no decision)
  remains only where no document has been decided: a create, and `port.read` of a path for a person
  opening a thread's context.
- **Create.** The record, the document's first text and its arrival are one unit
  (`documentCreation.createDocumentAtomically`; `live-create.ts`). A create never replaces or
  joins another document, and is never refused for a name: beside a node of that name it makes a
  twin (rule 14), and the answer's URI is the path it landed at (`Landed`, spelled by the router),
  a twin's leaf with its `~id`. A `~id` segment that reaches no node reads as its name, for writers
  and readers alike (`childAtSegment`, the SQL walk), so a create there lands under the name. The
  model's `create` reuses the empty document its path reaches; one with text makes a twin
  (agent-edit marks the write `occupied`, and the host ensures again with `beside`). A text document created in a
  Work's version needs nothing more: its Live room starts empty, and its text lands there.
- **Move and rename.** Within a list a move, rename or reorder is a record of a tree command
  (`port.treeCommand`; the model's `move`, the browser's own records). A move writes no document
  bytes. A move stays in one list: a project's files are one, the account's `user://` another.
  Between the two the action is Copy (`port.copy`, `copy/copy-command.ts`), which leaves the
  original where it is; the model's `move` across the two runs it (`lib/model-tools/tree-copy-across.ts`).
- **Delete.** Every delete, the writer's, the upload remove and the AI's, drafted or live, is a tree command.
- **Edit history.** The model's tree entry (`recordAgentTreeChange`) is written in the same
  transaction through `inTransaction` / `afterWrite`.

- Copy's `commands` row (`kind: "copy"`, `copy/copy-commands.ts`; its outcome holds the
  receipt) owns the transaction: the claim is its first write, every answer it stores is `done` (a
  copy, or no entries with `settled` saying why), an error rolls the claim back so the id stays
  sendable, and another request under the id answers `command_conflict`. Inside it the command transaction
  (`commandTransaction.run`) takes the destination's Work and, through `treeListStore.submit`,
  its list. The sources are a frozen cut, so their lists are not locked
  and a source deleted mid-copy is a copy of what the writer saw.

## Copy

A Copy is one atomic command per drop: ordered roots (documents and folders) into one
destination folder, with an optional sibling position.
`POST /api/projects/:projectId/context/copy` and `./mf doc copy` drive it; the browser's
Copy intent is not built yet. The pieces: `copy/copy-port.ts` resolves the request's
addresses to adapters, `copy/copy-command.ts` reads, duplicates and orchestrates, and
`adapters/context-fs/copy-adapter.ts` (source read) with `copy-tree.ts` (insertion) is what
one source's tree contributes.

- Each source tree is listed once (`ContextCopyAdapter.snapshotSource`, by node id, in the source view) and each
  tracked document's content is read once as a frozen cut (`readEffectiveBlocks`: the live
  document, or the Work's draft fork where it has one). A Draft view reads live content for
  documents the draft has no fork of, while spelling links in the Draft tree. The listing is a
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
  identity destination through the router's one resolver (`permission_denied` when the writer
  cannot command it), then the destination adapter inserts the plan (`copyInto`) as one `submit`.
  Copy and Agent files share `copy/bind-tree.ts` and `adapters/context-fs/copy-tree.ts`:
  Copy binds document blocks; Agent files bind plain code text for the planned address. The
  insertion accepts several destination folders in one submission, installs their initial
  states atomically, and schedules projections after commit. A failed plan creates no folders.
  The destination folder is followed by id: a folder that moved is the folder where it is now
  (the plan is made again for its new address), and one in Trash is the parent the roots are
  created under, so the tree's rule 3 stands it again around them (`insertTree`'s `parent`).
  A folder moved to another Work or scheme under the lock is a retryable `io_error`: the lock
  held is the old Work's. A project scheme's destination never locks the port's primary Work
  (`workScopeId` is null for it): a Copy out of a closed Work into a project scheme lands.
  When the destination's Work is archived or deleted, the Work lock throws inside
  `commandTransaction.run`, before anything is written, and `copy()` stores a `done` receipt with
  no entries and `settled: [{ rule: "returned", why }]`, releasing the duplicated objects since
  that transaction commits.
- A copy keeps its source's names ([names
  repeat](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/placement-and-naming.md#names-repeat)):
  beside a node of that name it is a twin. The plan (`planCopy`) reads nothing of the destination;
  the entries the insert answers carry the paths that landed (`insertTree`).
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
  so it lands only in an empty document) and encoded to its first state
  (`encodeSeed`) outside the lock. A copy into a Work's draft view is the draft's pending create:
  its text is written straight into the document's Live room (`writeWorkCreatedContent`), and the
  pending create is its whole pending state; it is not a live arrival. The live insert is one `submit` of `create` records
  (`SourceTree.insertTree`, ranks from `generateNKeysBetween`); the creation aggregate
  (`createDocumentsAtomically`) persists the identities, `installSeeds` writes the seeds' Live rows (`encodeSeed`'s states), and every arrival settles once, so ahead refs pointing at a copy's new address
  settle. Projections and link rows are derived after the transaction commits, four documents at a
  time (`refreshDocumentProjection`), and the answer does not wait for them: a successful answer
  means the rows are committed, not derived. A derivation that fails is logged and the stale sweep
  recovers it. `metadata.copiedFrom` records the source URI, the version read and that version's
  revision.
- A Copy follows ids, never the path the writer saw. The route finds each source by node id
  (`availability.held`, `inTrash: true`: where it stands now, or the last address it held in Trash,
  in a closed Work too) and passes that address; the adapter reads the subtree by id
  (`ContextDocumentStore.readSubtree`: the node and what its own delete took, or what is live
  under it). A node in Trash is read on a `command` grant, since a deleted file's `read` is
  none. A source the project no longer holds (purged, or in another project), a document whose
  bytes were released, and a root that would land inside itself are left out: the Copy lands
  the rest and `settled` carries `left_out` with `purged` or `would_loop` and the roots' addresses.
  A destination folder the project no longer holds copies nothing (`left_out`, every source).
  Nothing is `stale_target` or `destination_missing` now.
  What is still an error and stores nothing: `invalid_operation` for the source root or a
  placement destination that cannot take a copy; `permission_denied` for a destination the
  writer cannot command; uploads as the destination (by path or by folder identity), a malformed
  path or room version, and a version sent for a folder, which the route refuses before the domain
  runs. A draft view names its Work and no chat: the server reads the document in that Work's draft
  (its fork, or Live where the draft has none); a Work outside the project is refused
  as `work_missing`. A draft source reads the Work's tree by id, so a folder copies with the
  documents the Work places in it, a document only the Work has included, and a node the Work
  does not place is left out as purged. The one name outcome left to the address-model
  research is `conflict` (a copy id another row holds).
- A client-held source sends its room version (`roomVersion`) with a document source (a folder source
  with a vector is a 400). The vector is compared with the document's Live room, whichever view
  is read: a Work's view has no room of its own. When the cut lacks updates it names, the read waits up to 2 s for the room to
  catch up, then answers a 503 `io_error` with `reason: "source_behind"` ("The source has edits the
  server has not received yet"): retryable and never recorded, so the same id may be sent
  again, and distinct from a transport failure. The browser sends the version of every open document (`openRoomVersion` on the session
  registry: its Live room) and sends
  the same Copy again, backing off from 0.5 s to 5 s, for as long as the answer is
  `source_behind` (`execute-copy.ts`): typing a tab holds always reaches the server
  (`findings/unsynced-probe.md`), so the wait ends.
- There is no Undo command: Copy's Undo is ordinary deletion of the identities it created.

## Catalog and publication

There is no catalog: the browser reads placement from the project's list. What the list cannot
say is the project's **sources** (`context_sources`): which node root is the manuscript, which is
a Work's, a lineage's or a chat's Scratch or uploads, and whose it is.

- `GET /api/projects/:projectId/context/sources` answers `ContextSourcesResult` for the project's
  owner: the project's own, each Work's until the Work is purged (an archived or deleted Work's
  read, and refuse writes), each lineage's and each chat's, while the source itself has not ended
  (a trashed chat's lineage or uploads end with it, and come back on restore). `GET /api/account/context-sources` answers the
  account's own `user://`. Each source carries the `authority` its addresses are spelled with.
- A source that begins (its first write provisions it), ends or comes back (a chat trashed or
  restored) publishes a truth-free `context-sources-hint` on the project's
  subscription through `ProjectHintPort`, after commit. A lost hint leaves the browser stale
  until its next read.
- A chat's uploads add what the list does not hold, `GET .../context/chat-uploads?chatId=`
  (`ChatUploadsResult`): `attachedAt` per document id. Deleting an upload is a tree `delete`
  record like a document's, used or not: a sent file has the chat's own copy
  (`chat-media/<threadId>/`), and Trash and the 30-day purge treat it as any document.

A delete is addressed by entry id: the router takes the node
(`{kind, nodeId}`) and an area; the area only decides which adapter to ask. The adapter finds the
node in the list's replay inside `make`, so a rename or
move by another writer in the gap is neither undone nor refused; the only facts it checks are about
the target (the occupant, the source the caller found the node in). A node that left the
source answers `stale_target`. A move keeps the node's name; into a folder that shows it, the node
is a twin.

## Document content and filetype rules

`ContextFS` resolves filetype before constructing document content. Existing text
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
binds once, to the first live document its address reaches through the tree's walk (a `Kael/Note` link reaches a Note in a folder `Kael~f1` beside a document `Kael`), for every holder:
a later occupant never captures it, nothing rebinds it, and a paste copies it
as is. A draft's hidden create and a deleted row are no arrival. Lineage
registrations compare the root id as well as the path, so two chats cannot
capture each other's waiting refs; a soft-deleted Work keeps its identity and
its files until the purge, so refs to its address bind while it is deleted. Refs in a document only a Work has, register globally and best effort: an agent's mint at its write, and
a link the writer types when the document's derivation runs (`registerUnregistered`, any
document a view still shows); a failed registration never fails the write. The context link-scope adapter must receive the same scope instance as
collab, whose [document authority notes](../../collab/.context/document-authority-and-schema.md)
hold the scope rules.

Zero or multiple matches resolve to `null`; resolution never guesses. An
archived or deleted Work still resolves as authority and lists its files until
its purge (`ProjectWorkAuthorityResolver`, `presentSourceId`, availability's
`placed` and `held`): its addresses read, and file policy refuses the writes as
if the files were gone. Only `lockById` refuses a deleted Work.

A ref-less address resolves in its typed scope; only chat falls back to a
document's previous locations, and only after a current miss. Personal scope
comes from authenticated route identity, never from the URI. Moves record each
vacated path in `document_previous_locations`, so bookmarks and chat history
reach the document by identity; an alias returns only when that identity is
currently available to the request owner in the requested project.

A link resolver is not a capability. A reader who cannot reach a ref receives
`gone` without a location. A document that exists only in the reader's Work draft answers `inDraft` with that draft and
path; another Work's draft-only document is not shown to the reader. Holder binding is stable by document identity, and
relative spelling uses only a holder the reader may name and read.

The address endpoint resolves a path in the live tree only; `./mf doc` commands resolve their URI through it (`tools/mf/src/commands/doc/uri.ts`). The browser
resolves every address from the replay of the project's tree list, a review address in its Work's
tree included, and never asks this endpoint. The resolver returns the canonical current locator;
it never makes a path-only URL a capability.

## Lineage and special namespaces

Lineage Scratch sources carry project and root-thread identity, not a Work.
Provisioning is lazy on the first AI write and shares the Scratch namespace
lock with trash/restore liveness. The source remains while any lineage member
is live, hides when the last member leaves, and restores with a live member.
The first chat may be trashed and still names its lineage; `ls` lists only
available notes. A lineage root names Scratch ownership, never a reader: draft
visibility for link answers comes from the selected Work's draft tree view, so
never pass `rootThreadId` as the viewing thread. Rebinding a chat selects a
different bare Scratch owner and never moves notes; the durable Work-switch
Notice names the previous Scratch root. Work purge ends the nodes of its sources (the Work's, its lineages' and its chats') with a
`purge` record in the project's list, releases their documents through `release-document-content.ts`
(a purged tombstone stays), then removes the source rows, memberships and blobs.

`unfiled://` is project-owned storage with the same ContextFS, Live rooms,
availability, and identity-preserving move rules as Manuscript and
KB. Its membership means not yet filed; a name does not change membership.

## Negative space

There is no `results://` scheme. The project's recently opened list doesn't live here:
it is `domains/recent-documents`.

## Downlinks

- [Context tree visibility and lifecycle](../tree/.context/CONTEXT.md)
- [Upload intake](../uploads/.context/CONTEXT.md)
- [File access policy](../../file-policy/.context/CONTEXT.md)
- [Collab codec and authority](../../collab/.context/CONTEXT.md)
- [Deferred work](FUTURE.md)

## Import reveal

An import stages nothing in tables of its own: each planned text seeds the document's Live room under the id its node will have, and the reveal (`adapters/drizzle-import-reveal.ts`) is one `submit` of `create` records for every planned node, in the transaction that finishes the import. The writer's `createAll` stores each name as planned (beside a node of that name it is a twin), ranks the top level after what the destination folder holds and a new folder's children in name order, and the store derives the `documents` rows from the records. A destination folder deleted meanwhile stands again (the replay). Then the reveal writes the properties and previews the records do not carry, registers ahead refs under the namespace keys they settle, and settles the arrivals.

