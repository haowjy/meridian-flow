# collab — live document infrastructure

This page records the contracts that cross collab's Loro rooms, persistence and transport boundaries.
The focused pages hold the press, authority, reversal and WebSocket details; this page keeps
their shared rules.

## Boundary

`CollabDomain` supplies the Postgres adapters around `@meridian/agent-edit` and
`@meridian/document-model`. A document's Live text is its Loro room (`DocumentRooms`,
`rooms/postgres-document-rooms.ts`, on `document_snapshots`): a structure doc and a text doc per
block. Phase 1 has no text drafts: every AI write lands Live, a named Work's included, and the
press works on a Work's pending tree records only ([the press](press.md)). Phase 2 brings a draft
back as a fork room of the document.

A model's document write is a command (`modelEdits().run` and `.write`,
[model edits](model-edits.md)); its reads enter through the agent-edit router
(`domain/agent-edit-router.ts`), which routes every one to the Live core. A draft's owner is the
Work it belongs to (`drafts.work_id`; a Work has several and one default), or for a chat with no
Work its lineage (the first chat, its forks and subagents; a handoff starts a new one). A chat
writes into the draft its root names (`threads.draft_id`, read through `Thread.draftId`, which
falls back to the Work's default when the root's draft is deleted or of another Work).
`shared/draft-owner.ts` is the one reader of a draft's owner and lifecycle (`draftOwnerSql`) and
holds the move rule (`carryRootDraft`: a chat that changes Work carries an unshared draft and
names the destination's default otherwise). A Work's drafts are listed, made, renamed, deleted
(`deleted_at`, Undo restores, purged 30 days later with its forks) and picked for a chat in
`adapters/drizzle-work-drafts.ts`. A lineage is writable while some chat in it is live. Scratch
and upload content is always live.

Nothing holds a write: each lands in its command's transaction, so a read always shows the
writes before it.

The composition root wires required services and provider ports. It owns no business behavior,
mutable runtime state, or optional capability matrix. `collab-facade.ts` only assembles the
domain surface. Agent-edit owns the memory-only mutation kernel; collab owns authorization,
persistence, and coordination.

## Revision and removal

`domain/document-revision.ts` (`cutRevision`) produces a revision from the room version, holder
URI, and sorted stored-link/image identities: the version covers every text and structure change,
the link spelling covers tree-only moves. Reads and applies compute the token synchronously in
their prepared link scope; an unverified recovery returns `null`, never a later read's token.

A removed document's rooms end (`RoomError` `document-deleted`) only while the removal still
stands: `closeRemovedRooms` reads the removal records once, outside DB locks, and tells the room
gateway (`onRoomsEnded`) about the documents still removed. A `deleted` removal retains all bytes,
so restoring the document finds its text as it was.

## Save, replay, and grants

A model's write runs in its command's transaction: the append, the receipt and the stored tool
result commit together, and live rooms receive the write only after commit, so a rollback is
invisible to open editors. The grant is confirmed once per write and a write whose Work lost
access is refused.

A chat's write mode (`threads.ai_write_mode`) is kept but sends nothing to a draft in phase 1: the
file grant's `destinationAt` answers Live for every write.

A write into a room where the model has no frontier plans on the current room. A write with a
usable frontier plans on the room at that frontier and merges onto the current room. A write that
changes nothing still reports the changes since the frontier and records its own. Every model call
reads its room fresh through agent-edit's `readRoom`, a copy of the loaded room taken without the
document's lock. A room is named `live:<documentId>` (`domain/observation-rooms.ts`).

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

Concurrent chat edits and writer deletions are Loro peers: a write merges with them. Who changed
what since a read comes from the changes' commit messages (`turn:<id>`), never text similarity.

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
Work and lineage of the set is active: new AI writes use it (`lockForWrite`), while a press on a closed owner's suggestions locks without it. A draft is minted with its Work or root chat, so no lock creates one. No other collab code locks a Work for a write; a Live write's
seam (`enterLiveSeam`) locks only the bound grants' Works. No keystroke enters the boundary:
no keystroke locks a Work or counts. Tests use the same boundary
(`apps/server/server/test-support/work-projection.ts`), with no catalog or
availability notice.

A command's room copy is read in its transaction (`DocumentRooms.read` inside it copies the stored
rows, merged with what the loaded room holds), so what it plans on is what it holds the lock for.

The lock order is one list, and every path takes a prefix-ordered subset of it:

1. In the database, the command's claim row (`runCommand`).
2. Thread rows of a Work's tree, parents first, when the command changes a Work's lifecycle or
   reverses a card's Work receipts (`lockWorkThreadTrees`: all the threads, then all the Works
   and lineages, so several Works never interleave their phases). A card's reversal locks only
   its receipt Works' threads and the chat's own, and each as the runtime's thread lock does
   (`lockThreadAsRuntime`: the thread's asks, the inbox advisory lock, the row), since its Work
   step ends those chats through that lock; the documents' Works lock as rows alone. Then Work rows (only through
   the Works mutation boundary, in ID order, with the lifecycle and grant locks `lockSeamWorks`
   takes), then the draft row.
3. **Every tree list key the command will write or resync**, in list-ID order: the project's list
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
4. The sorted document advisory keys (`lockDocumentMutation`, in ID order), before the command
   reads. A keystroke takes none: the room imports it in memory and saves on its own connection.
5. Writes: a list's append and the rows it materializes (`tree_nodes`,
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
whose first write is the claim, then the list above from the Work rows on. A command that needs a
live room reads its copy in the transaction under the document key. A
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
No process-level lease or mutex exists. A failed push is reported and not retried: the next Live
commit or the next connection to the room catches it up.

## History and derivation

A room's history is its docs' Loro oplogs. History is compacted by age on unload (design §4,
"History cutoff"): a room past about 5 MB has each doc cut to its frontier as of 7 days ago
(`history_mark`), and a client update that depends on history below the cut is refused
(`HistoryCutoffError`, `RoomError` `history-cutoff`). A write whose recorded frontier is below the
cut plans on the transcript instead ([agent-edit](../../../../../../packages/agent-edit/.context/CONTEXT.md#the-edit-core)).

`domain/document-derivations.ts` is the sole pipeline from a document's text to stored text:
block rows, the order and counts on the room row, `documents.size_bytes` and
`updated_at`, and the link index. It derives from a cut of the Live Loro room taken under the
document's mutation lock (`captureDocumentDerivation`), stamped with `documents.content_seq`.
Every committed save of a Live room bumps `content_seq` in its transaction and, after commit,
schedules a derive (`onLiveSaved`); a compaction rewrites rows without bumping it. Typing a tab
sent but the room has not saved yet can be in a cut, and that save makes the cut stale. Recovery
sweeps stale rooms and retries failures without advancing certification.

Storage is `document_block_rooms` (one row per document: `block_order`, word count,
`pending_changes`, `document_hash`, and the `cut_*` and `extractor_version` watermark) and
`document_blocks` (one row per top-level block, keyed by its block id: `text`,
`content_hash`). A block row never holds its position, so inserting a
paragraph rewrites one array and no block row. Certify (`certifyDocumentDerivation`) is
under `lockDocumentMutation` and does only this: compare-and-set the cut against
`content_seq` and the location version, read the `(block_id, content_hash)` pairs, upsert the blocks
whose hash changed (all of them when the room's `extractor_version` is older than the cut's,
since a hash does not cover how the text was extracted) and delete the removed ones, replace `document_links`, and write the
room row (`block_order` only when the order moved). Text is produced and hashed before
the transaction, so certify never reads text back and a later normalizer can run there
too. Certify reads the project only for a new room or a moved one (`cut_location_version`
differs): a move bumps the location version, so the re-derive corrects `project_id`.

Reads of the block rows go through one port, `BlockText` (`domain/ports/block-text.ts`,
`adapters/drizzle-block-text.ts`): `grepTexts` and `wordCounts`. The adapter owns freshness. A
reader trusts a room only when its `cut_content_seq` and `cut_location_version` match the
document's and its
`extractor_version` equals the code's (`staleForReaders`); anything else is unknown to the
reader, which reads the document itself (grep) or shows nothing (`ls -v` word counts). The
blocks hold Live's text. A Loro room holds no suggestions, so a derivation writes
`pending_changes` empty, and `grepTexts` still leaves a document out for a reader in a Work that
column names. Phase 2's forks replace it. The
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

Stored text is never substituted for the Live room when serving document content, with one
exception: `grep` matches a document's stored text (the blocks' `text` joined with `\n`
in `block_order`, in one statement with the freshness check, and equal byte for byte to
the room-copy path's text) when the room is current and the reader's own Work has no
suggestions in the document. Bump `DOCUMENT_EXTRACTOR_VERSION` when what a block row holds changes.
Nothing else reads stored markdown: `ls -v` word counts come from `BlockText.wordCounts`
(current rooms only); everything else reads the room through the engine
(`domain/markdown-document.ts`), where a document with no stored rows reads as empty.

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
revision that version reports, the holder its links spell from, its room version, and
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

A result's concurrent attribution reads only the changes after its stored observation frontier
through the rendered cut. There is no preflight or second recheck.

`document_links` is a hint from a certified cut, never link authority. Unlike the blocks it
is read from the stored document, every Work's pending links included: its only reader is
ahead-ref registration, and a link a Work suggested needs its ahead ref registered to settle.
A reader that shows these rows to a person (backlinks) must filter them to a view first. Changing
the extractor bumps its version, and no second post-write writer exists.

## Inverses

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
- [The press: Apply and Discard of a Work's tree changes](press.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[kb-archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/work/lifecycle.md#archive-freezes-the-works-own-material

## Producer shutdown

Ahead-reference registration's `shutdown` stops scheduling and joins its running work. Callers await collaboration disposal before destroying
warm documents or resetting fixture rows. The PostgreSQL collab harness
owns that ordering in `dispose`. `flush` remains assertion-time convergence, not shutdown.

## Import staging

A first state is written one of two ways, by where its content comes from. Import stages it, because
the import queue must keep the encoded states across generations and discard them when a
generation is refused. A Copy encodes it in memory (`encodeSeed`) and installs it inside the
transaction that inserts the documents (`installSeeds`), because it holds the bound content already
and has nothing to resume. Both seed the document's Live room (`DocumentRooms.seed`); neither
writes over a room that holds text.

Planned import binding uses stable `doc:<id>` targets before those documents are visible. Its ahead mints remain unregistered until reveal. Ordinary binding still runs before the command transaction, uses the current `LinkView` and folder addresses, and registers through the durable refusal-preserving registry.
