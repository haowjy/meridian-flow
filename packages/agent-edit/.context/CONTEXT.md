# agent-edit — contracts and architecture

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md): what a host must do that the port types can't say.
- [Write architecture](write-architecture.md): planning, capture, targeting and results.
- [Link identity](link-correspondence.md): ref assignment at every write door.
- [Diff](diff.md): the block diff and block correspondence.
- [Content merge](content-merge.md): the three-way block merge and what an AI edit's change is in a text now: its rules, repairs, rescues and known losses.

Deferred work is in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
directions are in [ALTERNATIVES.md](ALTERNATIVES.md).

## Block correspondence

`src/diff/correspond.ts` decides which old block is which new block. The content merge asks by
id (`byId`: [diff](diff.md#block-correspondence-by-id)). Everyone else asks in guess
mode, for every writer of a sequence of blocks: `resolver/block-alignment.ts` (the model's write)
and, inside a block, the writer's atoms (breaks, images). Identity comes from content with attributes left out, chosen over the
whole run, so an attribute-only change (an indent) pairs a block with itself; blocks of
one type only, since an element cannot change type; a split or join is one unit rooted
at its first block, and its pieces are of that type too. The pairing is always one ordered
set: of blocks that cross (swapped paragraphs, a repeated line) one stays and the other is
deleted and inserted. A gap small enough to score whole pairs by shared words, and a weak
overlap beats none; blocks of one type that share nothing still pair by position there. A
larger gap is cut first at the pairs that clear the similarity bar (longest in-order
chain). A block's candidates come from a word index of its rarest words plus the blocks at its
place, counted from the gap's start, from its end and in proportion, so misleading rare words
never leave an edited block unpaired. Each piece between them is treated the same way. A piece
still too large pairs nothing new: never by position, never by weak overlap, and never does the
budget remove a pair the cut found. An unpaired block is deleted or inserted, and nothing else
rebuilds a block. Inside a block the model's write goes through one lowering
(`resolver/lower-block.ts`) and one adapter (`applyOps`, `model/loro-model.ts`): a container's
children pair here too (by id where they have ids), and text is word-diffed as units. The model's
write carries no ids (it writes text), so its pairing is by content only; `diffBlocks` pairs by id.

## The edit core

`tool/loro-write.ts` (`createLoroEditCore`) runs `read` and `write` on a room's Loro docs
(`AgentEditRooms.readRoom`, one `RoomDocs` per call, freed at the call's end).

- **Block identity is the block id.** Hashes are `fullHashForBlockId(id)`'s unique prefixes, and
  `ProjectedBlock.key` / `BlockSnapshot.key` carry the id, so echo, receipts and links share one
  path.
- **A write plans on what the model read**, so a word the writer deleted after that read stays
  deleted. The read's frontier is a per-doc map (`loro-frontier.ts`, `encodeFrontierMap`), the
  reply's own batches merged in by their end version; the write plans on `docs.at(frontiers)`,
  exports one batch (`exportSince(shownVersion())`) by its turn (`commitMessage`, `{by: {turn}}`) and
  saves it through `rooms.save` with an `AgentWriteRecord`: its `edit` (`editSince` in
  `@meridian/document-model`) is what Undo judges and takes back, and its `delta` (`captureDelta`)
  the blocks before and after, which the card's rows and the edit listing show.
- **A Draft chat reads and writes its draft's fork room** (`AgentEditRooms.readRoom`, the host's
  `roomFor`) from its first read; nothing in the core branches on Live or fork beyond `format:
  "changes"`. The host's lookups answer by document: the chat's latest read of it in any of its
  rooms (`FrontierLookup`). A write plans on that read when its room can check it out
  (`latestRead`, `planningFrontiers`): a Live read can be checked out in the fork, since a fork
  holds every Live op, and a fork read in Live only while the draft has written nothing there.
  Otherwise the write is `uncomparable` and plans on the transcript, the document's shown blocks
  from every room. An earlier read is never used in place of the latest: the model works from the
  latest text it saw.
- **`format: "changes"`** (`tool/draft-changes.ts`) shows each top-level block with a pending change
  (`changedBlocks`, what Review changes lists) as CriticMarkup of Live's text to the draft's, a moved
  block marked `{>>moved<<}`, then each comment whose body the draft changed (`comment on <hashes>:`).
  Closing delimiters in the text are escaped. On a Live chat it succeeds and says nothing waits for
  review. It records the read's frontier like any read.
- **A press since the read changes nothing in how a write plans.** Apply imports the draft's own
  ops into Live, so the fork reads as it did; Discard takes the draft's change back by content, so
  a write planned on the read merges like an offline peer's and the Discard stands. Planning on the
  fork as it is instead would bring back what the writer discarded. The report names a press
  (a commit by a press) as `the user's Apply or Discard`.
- **A write the view already holds** answers `unchanged` and lands nothing: on the model's view it
  is a no-op, as an offline peer's would be. When the room no longer holds it (someone changed
  those blocks since the read, a turn Undo of the chat's own words included), the answer says the
  text was edited since and shows it, with no instruction to write again, and the next write plans
  on it. Planning such a write on the room instead would undo edits the model never saw.
- **A `find` names text, not blocks.** It matches the view first; when the view doesn't hold it
  (the writer typed or restored it since, a turn Undo included) or what it matched is gone from the
  room, it matches the room as it is now. Text the room plainly holds is never `not_found`.
- **A frontier below the history cutoff** falls back to the transcript (`transcriptMerge`): each
  block a stored result showed in full (`{hash, body}`, latest showing wins) is the base, the
  model's command applied to it is ours, the room now is theirs, and the three-way content merge
  writes the result as a whole-document replace. A block with no full showing whose writer edit
  came after the read is what the fallback loses; a block deleted since answers `not_found` with
  the current text.
- **Who changed what** (`tool/loro-observation.ts`) comes from the docs that changed since the
  recorded frontier and who their commit messages say wrote them (`authorsSince`, by
  `readCommitMessage`): a turn is a chat (`authorOfTurn`), the reader's own turn is skipped, a
  press is the writer's Apply or Discard, and a commit by no one (typing, a tab's Undo) is the
  user. A structure change credits every
  author of the structure doc since the read with every structural change: coarse, never wrong
  about who touched the document.
- Write handles (`e<N>`) come from the host's `WriteOrdinals` (`ports/write-ordinals.ts`), one
  counter per chat and document.

The server's host (`apps/server/server/domains/collab/adapters/loro-agent-edit-host.ts`) runs
this core for every chat: `recordWrite` gets the record and the batch and writes the receipt in the
commit's transaction (`room`, `before`, `after` and `edit` on the part), and the model's `undo`
and `revert` go through `LoroDocumentEdits`, which returns the batches it committed so the reply's
frontier covers them. Its `roomFor` gives a Draft chat its draft's fork room, its lookups are per
document across the document's rooms, and its inverse (`drizzle-turn-inverse.ts`) takes each
part back in the room it was written in by design §2's Undo rule (`undoInRooms`, `undo-in-rooms.ts`,
over `undoEdits`): every write goes back whatever was written since, but one whose room cut its
history, which stays and the answer says so; a part already taken back is skipped. The
in-memory host (`test-support`) calls the same `undoInRooms`, also for `Restore before` (the
turn's parts in the draft, newest first), and runs the writer's Apply, Discard and `Restore before` as the
server's press does. Probe: [loro-write](qa/loro-write.md).

## What an Undo reads

Each AI write records its Loro `edit` (`AgentWriteRecord.edit`, a `StoredEdit`), and Undo, revert
and the card's state take it back with `takeBack`, the rule a press's Undo uses (design §2, "An
Undo always runs"): the write's characters that still stand come out and what it deleted comes
back, so the writer's typing inside or over the AI's words stays.

A block write keeps who wrote which characters only where text was inserted: `retainShared`
(`resolver/lower-block.ts`) keeps the old characters of a changed run and writes just the
insertions when the old run is a subsequence of the new one (`dog`→`dXoYg`, `cat`→`cats`).
Any other change, a deletion inside a word or a letter swap, writes the run whole, so a replaced
word never has letters of two authors. Spaces follow their own rule (which bordering space a
deletion keeps, by who typed it): [write architecture](write-architecture.md). Probe:
[lowering](qa/lowering.md).
