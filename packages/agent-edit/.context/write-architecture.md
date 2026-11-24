# Write architecture

`tool/loro-write.ts` is the composition facade. The resolver-to-apply currency is typed
ProseMirror content, not Markdown strings or raw CRDT updates: `applyEdits` never
parses or serializes. Resolver and apply code stay CRDT-neutral through the opaque
`DocHandle` and `BlockRef`.

The model's view, frontiers and the concurrent-change listing are in [The Model's
View][view]; undo and revert are in [Agent Editing and Reversal][reversal].

## Identity and targeting

- Navigation targets and echo targeting store a block's id, never the displayed hash, which is
  the shortest sibling-unique prefix and can change width. Only the rendered cut chooses the
  display hash.
- A find write rewrites only its matches. It splices the content into the serialized
  block group, reparses it, and word-diffs each match's text window on its own
  (`cutTextWindows`), so a word outside the match anchors nothing and a word inside it that
  the model kept is not written; a find whose windows can't be mapped is word-diffed over
  the whole block.
- The model's text is parsed where it lands, never alone. Every parse of it (a write's
  content, a find's spliced group and the windows cut in it, `shownNode`'s round trip) takes
  `{ within: open }`, the `open` of the block it lands beside: the first block a replace or
  find covers, the block an insert goes after or before, none for a whole-document write. The
  codec parses a stub that opens the same containers, then drops the stub's blocks, so indenting
  a line or writing `>` places it under the containers there. The block bodies a find
  splices and `lowerBlock` compares come from one serialization of the whole document
  (`documentEntries`), because a block's prefix depends on its neighbours. Copied blocks lose
  the containers they shared in their source and take those of the block they land beside
  (`landCopies`). A new quote written next to an existing quote joins it: only the editor
  writes `|`.
- A write is planned on the model's view and never reads the room; the one thing it reads beyond
  the view's text is who typed each character of the view (below). `lowerBlock`
  (`resolver/lower-block.ts`) lowers the rewrite of a block into operations (`EditOp`):
  per textblock at any depth (a paragraph or heading, code block, or a paragraph in a
  table cell; a list item or a quoted paragraph is a paragraph with nesting attributes), text splices with format ranges; per node at any depth,
  attribute sets (a paragraph's heading level, a task item's `checked`, a code block's language);
  for an inline atom the model kept (an image, a line break), attribute sets
  addressed by its unit; and for a container whose children differ (a table that gains a row),
  `insert` and `delete` of nodes, the children paired by `correspond`. A unit is one UTF-16 code unit of text, or one inline atom. The
  model's changes come from the word diff, over a find's windows or the whole block (`wordDiff`: it splits words with
  the review tokenizer (`segmentText`), so each character of a script written without spaces (Chinese, Japanese, Thai) is a word, and the word the model
  changes is the unit that lands; an atom is one token, compared by type, and a changed attribute is an attribute set;
  formatting is not part of a token). A changed run that only gained characters (the old run is a subsequence of the new)
  writes just the insertions (`retainShared`), so the old characters keep their ops; any other change writes the run whole.
  Changes that only whitespace separates become one change. A change that deletes words takes
  one bordering space with them and keeps the other: the one whose author also typed the kept
  word beyond it, read with `LoroText.getEditorOf` on the view (`AgentEditModel.unitAuthors`),
  else the one after. The word diff alone keeps either of two equal spaces, and when it keeps the
  one the writer typed beside words the model deleted, the writer's Ctrl+Z takes that space out
  and glues the model's words (`before we of course are able` rewritten as `before we can go`
  gave `before wecan go`). Authorship comes from the view, never the room: it is part of what
  the model read, so the plan still depends only on the read. A space typed during the write is
  not in the view, and the default side decides it.
  A comment (any mark with `markdown: false`, which the model cannot see or write) on words the
  model replaces with non-empty text moves onto the replacement's words, as bold the model could
  see would; on words it only deletes, the comment goes with them. Nothing new is stored and
  nothing is reported. The marks ride in the splice's content, so the one text write sets them.
  Every operation is made and Loro merges it,
  as for two people. The lowering never reads the room, so text the writer deleted since
  the model's read is no input to it. The owner chose that the writer's edit to a word the model kept wins, even where that
  leaves a fragment, and to trust the model to notice an odd merge in the write's echo and its
  listing of concurrent edits (`sighed softly` over a deleted `sighed` lands `He softly,`;
  `DRAFT-B3 line.` over a deleted `DRAFT-B line.` lands `3`). A word the model
  replaces lands as the model's whole replacement: `Gamma` over a deleted `Beta` lands whole, because a trim of the
  shared edges loses model letters (`Gamm`) and was removed. The apply step never reads the room either: the update deletes what the model's
  view held, including units the writer has since deleted, and Loro merges it. The write's
  record is its `delta` (the blocks before and after, in the model's view), so the record and turn
  Undo never claim the writer's deletion. An attribute the codec does
  not write (`uploadToken`) is never set: the model's node is compared with what the codec
  shows of the node it saw (a round trip of the top-level block, read where it sits), so a model edit to a
  paragraph leaves an image whose upload is in flight alone.
- Block ids (`id` on every block): the model's Markdown has none, so `projectBlocks` hands the
  resolver nodes with ids removed, and a block it leaves alone still compares equal to its own
  Markdown. A block edited by operations keeps its id; an inserted block, and a node inserted
  inside it, take fresh ids (`withBlockIds` in `applyOps`).
- `lowerBlock` is total for two blocks of one type: a block is never rebuilt, so it keeps its id.
  An inline atom added or removed is a splice of the block's text.
- What that guarantees, for a block it keeps, and no more:
  - The write's record holds only what the model changed in the room it merged into, so
    Undo restores the writer's exact text.
  - The model's new text lands where the model put it, even beside or in place of deleted
    text, so pieces such as `the, steadily moving train` appear. Nothing marks or reports
    them; the echo shows the merged text.
  - Words the writer deleted can still appear as the model's text: the model's new text
    may contain them, and when the model moved text past a deletion, the half of the
    move that lands can carry them (`First. Second. Third.`, `Second. ` deleted, written
    as `Second. First. Third.`, gives `Second. Third.`).
- The view keeps the room's deletions. Never drop them from the view and re-diff: the
  word diff would then place the model's text at the dropped run's edge, where Loro
  orders it against what the writer typed there by peer id (`He  loudlygroaned.`).
- What the lowering does not cover:
  - A write that removes a block and adds another (merging or splitting top-level
    paragraphs): the writer's typing in the removed
    block goes, and text deleted from it can come back in the added one.
  - Two changes the model makes to one word where the writer retyped it merge by peer
    id, as two people's concurrent typing does.
- Equal serialized content does not preserve CRDT identity or history, so rebuilding an
  existing copy from Markdown as a merge path loses both.

## Room copies

- A call reads one copy of the room's docs (`AgentEditRooms.readRoom`) and frees it at the call's
  end; every write is planned on that copy at the read's frontiers (`docs.at`), with a fresh peer.
- Forward-write attribution comes from the commit message (`by: {turn}`, `commitMessage`) and the immutable
  receipt, never transaction-origin identity.

## Results and lifecycle

- `renderAgentEditResult` is the only path from typed result to model text. Hosts keep
  the typed value beside the rendered text and never parse text back.
- Echo text is verbatim and exact-matchable: truncation may drop a suffix but never
  normalizes what it keeps, because a whitespace-collapsing cleanup breaks the model's
  retry on text it was just shown (find-all deletion legitimately leaves double spaces).
- A write's result names, by block hash and author, the blocks others changed after the model
  last read them, and marks those its echo already shows (the merged text, where a mangled merge
  would be visible). The list never tells the model to read again: the write landed, and the
  next write plans on what the result showed. Authors come from the changes' commit messages
  (`tool/loro-observation.ts`), never a text diff. Every person prints as `the user`.
- A result never tells the model to read again or to retry. A write that cannot land because the
  document changed under its view answers `returned` (`returnedWriteResult`): the block it named
  is gone (`block_gone`, decided by `hasMissingTarget` against the room copy), or the host found
  its Work closed or its document removed. The result carries the
  document as it stands, recorded as the model's latest view, so its next write plans on it. A
  hash or number the view does not hold (`not_found`) carries the current text for the same
  reason. An insert whose anchor block was deleted is not missing its target: it is new words,
  applied on the view, and Loro places it where the anchor was. An undo
  or revert that finds its text applied, discarded or changed since is `done` and says what was
  left (`cant_*`, `insufficient_*`, `nothing_to_revert` are outcomes, not errors).
- Provider tool IDs are response-local: the host keys a write by response and tool call, so
  a later response reusing an ID is a new attempt. The package keeps no idempotency of its own.
- Copies pass nodes from host read results rather than reading source documents inside
  the kernel, so whitespace and blank paragraphs survive and copied blocks receive fresh
  identities.
- `move` and `delete` are on `WriteToolInputSchema` but not `WriteCommandSchema`: they
  change where a document lives, so the host runs them and reports through the same
  envelope.

[view]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/model-view.md
[reversal]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/agent-editing-and-reversal.md
