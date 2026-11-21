# collab — live document infrastructure

This page records the contracts that cross collab's Yjs, persistence and transport boundaries.
The focused pages hold the press, authority, reversal and WebSocket details; this page keeps
their shared rules.

## Boundary

`CollabDomain` supplies Postgres/Hocuspocus adapters around `@meridian/agent-edit`. There is one
Y.Doc per document, its Live room. A Work's draft is that Work's suggestion marks in it
(`packages/suggestions`), plus the Work's pending tree records on its draft; Apply and Discard
of them is [the press](press.md).

A model's document write is a command (`modelEdits().run` and `.write`,
[model edits](model-edits.md)); its reads enter through the agent-edit router
(`domain/agent-edit-router.ts`). A drafted read or write (Draft mode, or a named Work) goes
through `draftView(work, author)`, which reads the Work's view of Live and writes into Live as
that Work's suggestions. Its owner is the chat's Work, or for a chat with no Work its lineage
(the first chat, its forks and subagents; a handoff starts a new one). `shared/draft-owner.ts`
is the one reader of a draft's owner and lifecycle (`draftOwnerSql`). A lineage is writable
while some chat in it is live. Scratch and upload content is always live.

Nothing holds a write: each lands in its command's transaction, so a read always shows the
writes before it.

The composition root wires required services and provider ports. It owns no business behavior,
mutable runtime state, or optional capability matrix. `collab-facade.ts` only assembles the
domain surface. Agent-edit owns the memory-only mutation kernel; collab owns authorization,
persistence, and coordination.

## Revision and removal

`domain/document-revision.ts` produces a revision from the encoded Yjs snapshot, holder URI, and
sorted stored-link/image identities. It must include both the delete set and the holder's link
spelling: a state vector misses pure deletion and a document snapshot misses tree-only moves.
Reads and applies compute the token synchronously in their prepared link scope; an unverified
recovery returns `null`, never a later read's token.

A removed document's live rooms close `4208`, but only while the removal still stands: after
every matching room load settles, one batched record read outside DB locks drops live rooms a
Work Restore has since made living again. A Restore that commits while that read is in flight
can still have its new live connection closed `4208`; the app's stale-4208 recovery reconnects
it. Only a committed removal closes live sockets. The room helper closes the gateway transport
before Hocuspocus's protocol close, which otherwise arrives as `1000`. A `deleted` removal
retains all bytes, so restoring the document finds its text, suggestions included, as it was.

## Save, replay, and grants

A model's write runs in its command's transaction: the append, the receipt and the stored tool
result commit together, and live rooms receive the write only after commit, so a rollback is
invisible to open editors. The grant is confirmed once per write and a write whose Work lost
access is refused.

A chat's write mode decides only where its new AI writes go; chats in one Work may differ. A
drafted write never applies itself: switching a chat to Auto-apply touches no suggestion, and
Apply stays the writer's press.

A write into a room where the model has no frontier plans on the current room. A write with a
usable frontier plans on that offline view, less the suggestions the writer rejected since
(`packages/suggestions/.context/CONTEXT.md`, "Who calls it"), and merges onto the current room.
A write that changes nothing still reports the changes since the frontier and records its own.
Every model call reads its room fresh through agent-edit's `readRoom`; the live adapter
(`adapters/hocuspocus-coordinator.ts` `liveRoomCopy`) reads the journal and the room without the
document mutex. A room is named `live:<documentId>` when the copy has a bound
authority (`domain/observation-rooms.ts`).

A call whose caller passes `frontiers` (the read and write tools, and reference reads, which
pass `recording` only) records an observation frontier in the room its result rendered from. A
write plans on the `planning` lookup when usable, otherwise on the current room; neither path
refuses concurrent text. An undo or revert records in the room its inverse committed into
(`DocumentEditResult.room`). `format: "edits"` reads record none. A model edit as a command
records its own, in its transaction ([model edits](model-edits.md#what-the-model-was-shown)).
See [runtime document text](../../runtime/.context/document-text.md#observation-frontiers).

A removed document, or an archived or deleted Work's view of one, returns the write instead: a
`done` row with `settled: returned`, and the document as that chat reads it now, its evidence
stored in the row so the model's next write plans on it. A block the writer deleted, merged or
moved is returned too (`block_gone`, from the write core). An insert whose anchor block the
writer deleted lands where the anchor was: it is new words, and the anchor's tombstone still
places them.

Replay treats ordinary concurrent chat edits and writer deletions as Yjs peers. A
planning-visible item disappearing is not by itself evidence against a write. Only immutable
inverse removals after the model's frontier revoke one.

Attribution is based on immutable journal provenance and dependency closure, not text
similarity or block proximity. Writer rows retain their identity. Agent writes use fresh writer
clients and journal their own transaction deltas.

## Transaction and lock contracts

Work-first order has one owner: the Works mutation boundary
(`projects/adapters/work-projection-mutation.ts`), a required dependency of
every collab store that writes draft rows. It locks the Works a write names, directly or
through its drafts,
`FOR NO KEY UPDATE` in id order, in the caller's transaction, before any draft,
inverse or document lock, so every write enters Work, draft, document, the order the
transitions take. A caller hands it its whole write set
once, through `lockWorks` (opening a draft, a press, a model edit's grants) or `mutate`, which is `lockWorks` then the write. Every Work locked
either way has its stored pending count reconciled at commit, and only a Work
whose count moved is notified (one SQL aggregate over the transaction's locked Works;
`projects/.context/CONTEXT.md`). `seam` adds the bound edit
grants' Works and confirms the grants; `requireActive` refuses unless every
Work and lineage of the set is active: new AI writes use it (`lockForWrite`), while a press on a closed owner's suggestions locks without it. A draft is minted with its Work or root chat, so no lock creates one. No other collab code locks a Work for a write; the
live journal's seam locks only the bound grants' Works. No keystroke enters the boundary:
no keystroke locks a Work or counts. Tests use the same boundary
(`apps/server/server/test-support/work-projection.ts`), with no catalog or
availability notice.

Room loads read in the caller's transaction because that transaction may
already hold the authority head. Provisioning locks the canonical thread row
before committing the peer in a root transaction, and the root must not re-lock that
thread. Referenced rows must be committed before a root
peer can reference them, so manifest identity and its live head commit in a
root transaction. Live manifest writes instead load the manifest in the
caller's transaction: during cold project bootstrap the project and source are
uncommitted and must roll back together, and no such path provisions a root
peer. Use `NO KEY UPDATE` where a root insert needs FK key
share against a caller-held lifecycle lock.

The lock order is one list, and every path takes a prefix-ordered subset of it:

1. Live `withDocument` mutexes (sorted), before any transaction.
2. In the database, the command's claim row (`runCommand`).
3. Thread rows of a Work's tree, parents first, when the command changes a Work's lifecycle or
   reverses a card's Work receipts (`lockWorkThreadTrees`: all the threads, then all the Works
   and lineages, so several Works never interleave their phases). A card's reversal locks only
   its receipt Works' threads and the chat's own, and each as the runtime's thread lock does
   (`lockThreadAsRuntime`: the thread's asks, the inbox advisory lock, the row), since its Work
   step ends those chats through that lock; the documents' Works lock as rows alone. Then Work rows (only through
   the Works mutation boundary, in ID order, with the lifecycle and grant locks `lockSeamWorks`
   takes), then the draft row.
4. **Every tree list key the command will write or resync**, in list-ID order: the project's list
   and the account's. A path that takes document keys takes all of them here (`treeLists.lock`,
   or `lockProjectTreeList`, which takes both of a project's), and no path takes a list key after
   a document key. A list's key sorts before every document key, not among them by ID.
   Then the namespace keys the command knows before it writes (`lockDocumentNamespaces`: a Work
   restore's, which a card reversal takes here, ahead of its documents, through
   `works.lockRestoreNamespaces`). One exception: a model edit's `registerInCommand` takes the
   namespace keys of the ahead refs it mints, which exist only as the edit plans under its document
   key, so they follow the document keys there. A path that takes namespace keys first and then a
   document key can therefore cross with it; none does today (Apply's and a restore's settle
   under the keys they hold).
5. The sorted document advisory keys (`lockDocumentMutation`, in ID order), each followed by that document's head row `FOR NO KEY UPDATE`, before the command reads. A keystroke takes only the head row.
6. Writes: a list's journal append and the rows it materializes (`tree_nodes`,
   `draft_tree_nodes`, `tree_node_ids`, `documents`), then the text. Derivation
   certification takes a document key and then locks that document's `tree_nodes` row, so a path
   that holds a document key writes its rows after it, and one that writes first never takes that
   document's key afterwards.

- **Press and unpress** take the order of [the press](press.md): Works, draft, lists, documents
  in ID order, then writes.

`submit` and `resync` take the list keys themselves when a path holds no document key, as the
tree tools do. `resync` takes none: it throws when the transaction does not hold the
key, so a path that would take one after a document key fails in its first test, not as a
deadlock. Apply, Discard of items, a card's tree Undo and the purge all take the key, then the
documents', then write. A tree list's write
(`withLists`) takes the seam's Work locks first, so the append under the key takes no lock it
lacks; a Work's close, archive, restore and delete takes both lists' keys after its Work row and
before its document keys (`lockProjectTreeList`), so the open Works an admission reads under that
key are current. No path takes a list's key a list's key while holding a document key. No writer-ingress epoch barrier remains.

A document command (a model edit, a tree tool call, `reverse_turn`, a press or unpress, Copy, the server's move between a project's list and the account's) runs in
`runCommand` (`shared/commands/drizzle-commands.ts`, through `adapters/drizzle-document-commands.ts`): one transaction, `runInCommandTransaction`,
whose first write is the claim, then the list above from the Work rows on. It takes no
`withDocument` mutex: a command that needs a live room reads its journal in the transaction
under the document key (`committedCopy` under `inLockedWrite()`). A
read a command plans on is taken, or taken again, under the locks of what it read: the inverse
captures off-lock to choose its steps, then reads the text each step writes under its Works,
document keys. A miss the server retries (a deadlock, a serialization failure,
a moved owner) rolls back past the claim and is never stored
as an outcome. In dev and test, a `KeyedMutex` or a second connection taken while a command
transaction is open throws (`assertOutsideCommandTransaction`): a wait on either is invisible to
Postgres and can hang both sides for good. The tree list store takes no mutex (its in-memory
copy is marked `pending` by the root transaction that changed it, and any other transaction
reloads; a rollback at any depth drops the copies the transaction held), so it joins the command's
transaction. A card Undo's Work receipts run in the same command as its documents
(`reversal.md`): the command declares every Work and thread it will lock and takes them before
its first document key, and reruns when its commit finds a Work it did not declare.
No process-level lease or mutex exists beyond the live room's `withDocument`. A failed push is
reported and not retried: the next Live commit or the next connection to the room catches it up.

## Authority, checkpoints, and derivation

A live document's authority identity binds its loaded Y.Doc, room, checkpoint, writer frame,
Markdown replacement, and agent journal batch. Persistence validates the binding under the
document mutation lock (a writer frame, under the head row it bumps) and drops stale bytes rather
than relabeling them; a retired handle's room is closed. A document's history is never replaced:
version restore is a forward write (`restoreFromYDoc`, below), because a browser's copy can't tell
one history from another (neither its room name nor its IndexedDB copy carries one). A copy that
predates a replaced history would merge the old one into it on reconnect, showing the text twice,
and would upload it to a server that has no record of the old one. The heads once carried an
authority generation for that replacement; with nothing replacing history it was always 1 and is
gone. Whatever needs to replace history (a rebuild) has to give copies a way to tell first, and a
way for their unsent typing to land.

A checkpoint is a host-minted `CapturedCheckpointCut`, not a free state-vector
and watermark pair and not warm-room bytes. It covers every journal row at or
below its cut. Materialize outside the persistence lock, then revalidate
identity under lock. A stale checkpoint returns
`stale_document`; it does not manufacture a successful checkpoint ID.
Live journal rows are deleted only by a purge:
the model's report of what changed since its last read attributes each
change from the rows after its frontier, however old. A background checkpoint
(`storeCheckpoint`, `background` set) deletes the document's other background
checkpoints in its own transaction, before it updates the head row every keystroke
frame waits on. A document holds its seed, its explicit checkpoints and one background
checkpoint. A capture whose base a later store
deleted replays from an older checkpoint and more rows. The manifest reads only the
rows after the checkpoint it builds on. Retiring live rows into a checkpoint has no code: one
that is built must fold into a checkpoint that is kept, not the background one the next store
deletes, and cuts captured before it must stop validating.

A checkpoint, a version and the background one alike, stores the document with the content of
its deleted items dropped (`materializeCheckpoint`, agent-edit's `dropUnseenContent`): each
item keeps its id, so a late edit anchored on deleted text still integrates, but its text,
marks and subtree are gone. A rejected rewrite then costs Live's history its item headers
(about a quarter of its bytes), not its words. Kept are the items the room's latest frontier shows
(the last model read of the document), so the chat working on it still plans on what it read
after a deletion; keeping every chat's last read would keep each rewrite a fresh chat wrote and
the writer discarded, for good. Every other
reader of deleted content was moved off it: press Undo and card Undo are by content
(`inverse-text.ts`), the edit list reads receipts, and `planningSnapshot` refuses a frontier
that saw an item whose content is gone (a fork planning on its parent's row, a race with the
capture). A replace in that case plans on the blocks the transcript showed the model, merged
three ways against Live, so text the writer deleted after the read stays deleted
([agent-edit](../../../../../packages/agent-edit/.context/CONTEXT.md#planning-on-what-the-model-read)).
Once a background checkpoint is stored the
room drops its own deleted content the same way (`cut.dropUnseenContent`), so a room that stays
loaded through a sitting copies no more per command than a cold load would. Between captures
the room stays `gc: false`, and the journal rows keep every byte. A version stored before this keeps its full
history and still restores.

A document rebuilt from journal rows is integrable only after every row has applied with no
pending structs and no pending delete set. State-vector equality, or a pending-struct check
before applying, is not enough. A room release queues a live checkpoint's immutable binding, and
a worker captures a durable cut after the releasing transaction commits. A dropped or late
checkpoint costs replay time, never data.

`domain/document-derivations.ts` is the sole pipeline from Yjs to stored text:
block rows, the order and counts on the room row, `documents.size_bytes` and
`updated_at`, and the link index. It derives from a journal-locked durable cut and
projects the cut's own private doc with `projectBlocks`, with no copy. Recovery sweeps
stale rooms and retries failures without advancing certification.

Storage is `document_block_rooms` (one row per document: `block_order`, word count,
`pending_changes`, `document_hash`, and the `cut_*` and `extractor_version` watermark) and
`document_blocks` (one row per top-level block, keyed by its Yjs item id: `text`,
`content_hash`). A block row never holds its position, so inserting a
paragraph rewrites one array and no block row. Certify (`certifyDocumentDerivation`) is
under `lockDocumentMutation` and does only this: compare-and-set the cut against the
head and location version, read the `(block_id, content_hash)` pairs, upsert the blocks
whose hash changed (all of them when the room's `extractor_version` is older than the cut's,
since a hash does not cover how the text was extracted) and delete the removed ones, replace `document_links`, and write the
room row (`block_order` only when the order moved). Text is produced and hashed before
the transaction, so certify never reads text back and a later normalizer can run there
too. Certify reads the project only for a new room or a moved one (`cut_location_version`
differs): a move bumps the location version, so the re-derive corrects `project_id`.

Reads of the block rows go through one port, `BlockText` (`domain/ports/block-text.ts`,
`adapters/drizzle-block-text.ts`): `grepTexts` and `wordCounts`. The adapter owns freshness. A
reader trusts a room only when its `cut_*` match the head and location version and its
`extractor_version` equals the code's (`staleForReaders`); anything else is unknown to the
reader, which reads the document itself (grep) or shows nothing (`ls -v` word counts). The
blocks hold Live's view (`packages/suggestions`); `pending_changes` names the Works whose
suggestions the cut holds, with their change counts, and `grepTexts` leaves a document out for a reader in one of those
Works, which then reads its own view from the room copy. The
sweep (`staleForSweep`, on the writer port's `stale`) differs on one point: it skips a room a
newer extractor certified, because builds overlap in a deploy, the older build's certify
refuses that room, and retrying it burns three attempts per room per sweep. A later read-side
prefilter should extend `grepTexts` (required literals in, a skip set out) rather than add a
second reader.

One function, `grepBlocksOf` (`domain/grep-blocks.ts`), projects a doc into blocks with their
destination-free markdown and grep text. The derivation hashes and stores it; `readHashlines`
adds bodies and links. That shared path is why the stored and room-copy texts agree.

`document_hash` is the ordered block `content_hash` list plus the link facts Live reads;
`updated_at` moves only when it changes, so an extractor bump or a move is not an edit.
`content_hash` is the hash of the block's destination-free markdown, not of its text, so
a formatting-only edit still counts as an edit. A block's `text` is the destination-free
markdown decoded to the text view; a code file's block is its code node's text with no
fence (`grepBlockText` in agent-edit). Sizes are therefore destination-free byte counts.

Stored text is never substituted for live Yjs when serving document content, with one
exception: `grep` matches a document's stored text (the blocks' `text` joined with `\n`
in `block_order`, in one statement with the freshness check, and equal byte for byte to
the room-copy path's text) when the room is current and the reader's own Work has no
suggestions in the document. Bump `DOCUMENT_EXTRACTOR_VERSION` when what a block row holds changes.
Nothing else reads stored markdown: `ls -v` word counts come from `BlockText.wordCounts`
(current rooms only), the trash preview is the engine's `readFrozenMarkdown`, which
serializes the stored Yjs on request, and `ensureDocumentAuthority` seeds an empty document
when a document has no state.

## Links and tree changes

Stored links and image sources carry stable `doc:` or `ahead:` identities;
Markdown does not. The scoped codec assigns or preserves those identities on
write and spells them from the current document tree on read. Moves and renames
therefore write no document bytes. Link extraction and revision hashing use
the same occurrence rules, and failed ahead-ref registration is repaired by
the derivation sweep.

A copy reads one document's frozen cut (`readEffectiveBlocks`): a Draft view reads the Work's
view of Live (`draftView`), with links spelled in the Draft tree. The cut holds
its projected blocks, the
revision that version reports, the holder its links spell from, its Yjs state vector, and
where each `ahead:` ref in the cut settles now. `bindCopiedBlocks` turns those blocks into a
fresh `BoundWrite` for a new holder through `domain/copied-blocks.ts`: identities inside the
copied set (a settled ahead ref included) name the copy, a ref-less internal spelling is read
from the source holder and either remapped or written absolute, an unsettled ahead ref whose
address now holds a copied folder names that folder (an ahead ref settles only on documents),
and everything else keeps its target. It resolves no catalog and mints no ahead ref, so it is
safe inside the copy's transaction — the one whole-document door that binds there rather than
before it. The
model's `copy` tool runs the same `remapCopiedBlocks` over its own read's blocks, with the
settlements from the same cut.

A result's concurrent attribution reads only the room journal interval after its
stored observation position through the rendered cut. There is no preflight or second
recheck. Baseline containment compares struct clocks and the delete set: equal state vectors
alone do not establish equality, so delete-only writer edits are still attributed.

`document_links` is a hint from a certified cut, never link authority. Unlike the blocks it
is read from the stored document, every Work's pending links included: its only reader is
ahead-ref registration, and a link a Work suggested needs its ahead ref registered to settle.
A reader that shows these rows to a person (backlinks) must filter them to a view first. Changing
the extractor bumps its version, and no second post-write writer exists.

## Inverses

A write never regenerates durable rows from a raw state-vector diff, which would reintroduce
cumulative tombstones. An unresolved sync dependency is an integrity failure, never a partially
journaled update. Manifest membership mutations still journal cumulative sync bytes
([#753](https://github.com/haowjy/meridian-flow/issues/753)).

An inverse is an ordinary immutable edit. It does not rewrite target rows, mark them
reversed, or use a reserved undo client. Card actions and model undo share immutable edit
origins, but keep their own authorization and stack policy.

Every model call obtains a private room copy through `readRoom`; no resident helper
or content cache survives between calls. Planning uses the model's
recorded frontier, while rendering uses the fresh room copy.

## Focused references

- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Model edits as commands](model-edits.md)
- [The press: Apply and Discard of a Work's suggestions](press.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[kb-archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/work/lifecycle.md#archive-freezes-the-works-own-material

## Producer shutdown

Ahead-reference registration's `shutdown` stops scheduling and joins its running work. Callers await collaboration disposal before destroying
warm documents or resetting fixture rows. The PostgreSQL collab harness
owns that ordering in `dispose`. `flush` remains assertion-time convergence, not shutdown.

## Import staging

Import preparation produces Yjs state, a state vector, and attribution without publishing document authority. Staged states remain private until Context reveals the matching generation; commit installs sequence-zero checkpoints and heads in the journal adapter's authority order, while discard removes only the bounded staged batch.

A first state is written one of two ways, by where its content comes from. Import stages it (`prepareSeed`, `stageInitialStates`, `commitStagedStates`), because the import queue must keep the encoded states across generations and discard them when a generation is refused. A Copy encodes it in memory (`encodeSeed`) and installs it inside the transaction that inserts the documents (`installSeeds`), because it holds the bound content already and has nothing to resume. Both install heads and sequence-zero checkpoints set-wise; neither writes over an existing head.

Planned import binding uses stable `doc:<id>` targets before those documents are visible. Its ahead mints remain unregistered until reveal. Ordinary binding still runs before the command transaction, uses the current `LinkView` and folder addresses, and registers through the durable refusal-preserving registry.
