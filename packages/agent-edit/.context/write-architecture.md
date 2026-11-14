# Write architecture

`write.ts` is a composition facade. The resolver-to-apply currency is typed
ProseMirror content, not Markdown strings or raw Yjs diffs: `applyEdits` never
parses or serializes. Resolver and apply code stay CRDT-neutral through the opaque
`DocHandle` and `BlockRef`.

The model's view, frontiers and the concurrent-change listing are in [The Model's
View][view]; undo, redo and revert are in [Agent Editing and Reversal][reversal].

## Identity and targeting

- Navigation targets store a block's canonical Yjs item tuple, never the displayed
  hash, which is the shortest sibling-unique prefix and can change width.
- Echo targeting and deletion anchors carry Yjs item identities, not display hashes:
  the same block can have a different unique prefix among the room's siblings. Only
  the rendered cut chooses the display hash.
- In-place block reorder is unsupported: position-based drag would silently rebind
  content to another block identity. A move deletes the old item and inserts a new
  one, so never wire a node's `draggable` or default DnD to reposition blocks.
  Figures move by cut and paste; drag-to-place is wanted and must be built as delete
  plus insert ([#111](https://github.com/haowjy/meridian-flow/issues/111)).
- A find write rewrites only its matches. It splices the content into the serialized
  block group, reparses it, and replaces each match's text window whole at its
  position (`cutTextWindows`); a find whose windows can't be mapped is word-diffed, and a
  block the lowering does not keep (below) is block-diffed instead.
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
- A write is planned on the model's view and never reads the room. `lowerBlock`
  (`resolver/lower-block.ts`) lowers the rewrite of a block into operations (`EditOp`):
  per textblock at any depth (a paragraph or heading, code block, or a paragraph in a
  table cell; a list item or a quoted paragraph is a paragraph with nesting attributes), text splices with format ranges; per node at any depth,
  attribute sets (a paragraph's heading level, a task item's `checked`, a code block's language);
  and for an inline atom the model kept (an image, a line break), attribute sets
  addressed by its unit. A unit is one UTF-16 code unit of text, or one inline atom. The
  model's changes come from a find's window, otherwise from the word diff (`wordHunks`;
  an atom is one token, compared by type, and a changed attribute is an attribute set;
  formatting is not part of a token). A replace is not trimmed: the model's whole new text
  is written. Every operation is made and Yjs merges it,
  as for two people. The lowering never reads the room, so text the writer deleted since
  the model's read is no input to it. The owner chose "the AI's whole word" and to
  trust the model to notice an odd merge in the write's echo and its listing of concurrent
  edits (`He sighedthen he cried.`, `AlphaGamma.`). A word the writer deleted that the
  model's new text repeats comes back inside it (`sighed softly` over a deleted `sighed`
  lands `He sighed softly,`). A trim of the shared edges would keep the deleted word out,
  but loses model letters (`Gamma` over a deleted `Beta` lands `Gamm`); it was tried and
  removed. The apply step never reads the room either: the update deletes what the model's
  view held, including units the writer has since deleted, and Yjs merges it. The write's
  record is made when the write is journalled, where the journal takes `heldDeletes` of the room before the
  update applies and `captureEditParts` drops those items from the part's `deleted`
  (a stale read, or a writer's delete that landed between the call's read and its append). The record
  and turn Undo therefore never claim the writer's deletion. An attribute the codec does
  not write (`uploadToken`) is never set: the model's node is compared with what the codec
  shows of the node it saw (a round trip of the top-level block, read where it sits), so a model edit to a
  paragraph leaves an image whose upload is in flight alone.
- Block ids (`id` on every block): the model's Markdown has none, so `projectBlocks` hands the
  resolver nodes with ids removed, and a block it leaves alone still compares equal to its own
  Markdown. A block edited by operations keeps its element and id; an inserted block, and a block
  rewritten whole (`applyBlockDiff`), take fresh ids. `insertBlocks` is the door where the codec's
  id-free blocks become stored blocks, so it assigns ids; `writeBlocks` refuses a block with none.
- Shapes `lowerBlock` does not keep return null and the block is rewritten whole, as if
  there were no room: a node added, removed or retyped inside the block (a table
  row), and an inline atom put into
  the middle of a run of text (a verse line broken in two). An atom added or removed at
  the edge of a run of text is an operation. Deleting an atom between two runs leaves
  them as two adjacent `Y.XmlText` children, which the editor's binding never writes;
  merging them would re-insert the writer's text as the model's, so they stay
  (the minimal-ops design, section 6).
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
  word diff would then place the model's text at the dropped run's edge, where Yjs
  orders it against what the writer typed there by client id (`He  loudlygroaned.`).
- What the lowering does not cover:
  - A block the lowering does not keep (above): a model change there that meets text the
    writer deleted since its read can bring that text back, and an insert beside a
    deleted line can land split, by client id
    ([TODO](TODO.md#stale-view-writes-into-structural-blocks)).
  - A write that removes a block and adds another (merging or splitting top-level
    paragraphs): the writer's typing in the removed
    block goes, and text deleted from it can come back in the added one.
  - Two changes the model makes to one word where the writer retyped it merge by client
    id, as two people's concurrent typing does.
- Equal serialized content does not preserve Yjs identity, tombstones or authorship,
  so rebuilding an existing replica from Markdown as a merge path loses all three.

## Room copies and views

- A view replays only updates the current room contains, so a retired one never enters it.
- Each captured segment takes a fresh client absent from both the view and the room
  copy, so parallel calls and write/undo/write in one reply never reuse a client.
- A draft read carries its resolved Work-draft identity into the concurrent lookup;
  attribution never requires or provisions a draft.

## Capture and receipts

The write listener captures synchronous Yjs update events for one logical write,
including its own structs and deletes but not inherited tombstones, and detaches
before journal submission, synchronization, recovery or failure. A state-vector diff
is not a per-write deletion delta.

Forward-write attribution comes from explicit actor context and immutable receipts,
never transaction-origin identity. Certified aliases are the only persisted
restoration correspondence, never text or length guesses.

Forward-inverse receipt capture removes cross-part insert/delete transients as ranges,
then intersects each range with the retained `prosemirror` item structs; other roots
and GC structs never expand into per-clock identities.

## Draft write granularity

One logical draft write may contain paragraph-level segments. Each segment is one
transaction with a fresh shared-protocol client; receipts stay per
tool call while storage expands segments into rows. Recognized adjacent splits and
merges and contiguous insertion or deletion runs stay one structural segment. Sharing
a paragraph alone never joins independent writes. A live write merges one update.

## Results and lifecycle

- `renderAgentEditResult` is the only path from typed result to model text. Hosts keep
  the typed value beside the rendered text and never parse text back.
- Echo text is verbatim and exact-matchable: truncation may drop a suffix but never
  normalizes what it keeps, because a whitespace-collapsing cleanup breaks the model's
  retry on text it was just shown (find-all deletion legitimately leaves double spaces).
- A write's result names, by block hash and author, the blocks others changed after the model
  last read them, and marks those its echo already shows (the merged text, where a mangled merge
  would be visible). Past `CONCURRENT_REREAD_BLOCKS` it drops the echo and the list and tells the
  model to read the file again; the write itself landed. Authors come from Yjs identities joined
  to the host's provenance, never a text diff. Every person prints as `the user`.
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
