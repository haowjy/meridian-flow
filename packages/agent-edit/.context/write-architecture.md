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
  position (`cutTextWindows`, `windowHunks`); a block that isn't a single run of text,
  or a find whose windows can't be mapped, is word-diffed or block-diffed instead.
- A write is planned on the model's view, so a block it rewrites in place may have
  lost text in the room since (the writer deleted it). Such a block is decided against
  those deletions (`removedUnits`, `withoutRemovedUnits` in `resolver/room-removals.ts`);
  every other block lowers as if there were no room. A unit is one content position: a
  UTF-16 code unit, an inline atom (hard break, image), or one edge of a nested node.
  The model's changes come from a find's window when it holds no deleted unit, otherwise
  from a token diff in which a Chinese or Japanese character is one token, a run of other
  letters is one (so a spaceless Thai phrase is one), and formatting is not part of a
  token. The rule: a change lands only if every unit it replaces survives; an insert
  lands unless it sits in deleted text; a delete deletes whatever is left; no deleted
  unit is put back; every change not made is counted (`skipped` in the result).
- What that guarantees, for such a block, and no more:
  - The write's update neither deletes nor re-inserts any unit the room deleted.
  - The model's new text lands only in place of units that all survive, after a find
    match whose last unit survives (flat text only), or as a diff-placed insert with a
    surviving unit, or the block's end, on at least one side.
  - A change not made is counted in the result and never marked.
  - Words the writer deleted can still appear as the model's text: the model's new text
    may contain them, and when the model moved text past a deletion, the half of the
    move that lands can carry them (`First. Second. Third.`, `Second. ` deleted, written
    as `Second. First. Third.`, gives `Second. Third.`, one skipped).
- How it is applied. Flat text (`isFlatText`) keeps the room's deletions in the view and
  lowers the landed changes as exact splices: dropping them would lose which side of a
  deleted run a change sits on, and Yjs would then order the model's text against what
  the writer typed there by client id (`He  loudlygroaned.`). Quotes, lists, verse,
  code blocks and other blocks lowered by a structural diff drop the deletions from the
  view first (`dropRemovedUnits`, before capture), because the diff anchors on old units
  and a deleted one would split the model's text around it.
- What the rule does not cover:
  - A flat paragraph whose formatting or attributes the model changed is lowered as if
    there were no room: splices carry no format ranges, and the structural diff lands
    the model's bold beside typed-over text by client id (`He **sighed loudly**.`). Text
    the writer deleted there can come back as the model's.
  - A write that removes a block and adds another (merging or splitting top-level
    paragraphs, a paragraph turned into a heading): the writer's typing in the removed
    block goes, and text deleted from it can come back in the added one.
  - The rule sees only what the writer deleted, never what they added. A model delete
    can take letters the editor kept from an old sentence inside a pasted one, and
    typing that deleted nothing merges as plain concurrent edits.
  - A find insert is decided by its match only in flat text. In a quote, list item or
    paragraph with a hard break it is a diff-placed insert, so it lands if a unit on one
    side survives.
  - A delete that lands after the call read its room
    ([TODO](TODO.md#deletes-that-land-after-a-write-read-its-room)).
  - Text the editor retyped (joined lines, a deleted image): a change to it is skipped
    ([TODO](TODO.md#edits-to-text-the-editor-retyped)).
- Equal serialized content does not preserve Yjs identity, tombstones or authorship,
  so rebuilding an existing replica from Markdown as a merge path loses all three.

## Room copies and views

- A view replays only updates the current room contains, so a rolled-back or retired
  one never enters it.
- Each captured segment takes a fresh client absent from both the view and the room
  copy, so parallel calls and write/undo/write in one reply never reuse a client.
- A draft read carries its resolved Work-draft identity into the concurrent lookup;
  attribution never requires or provisions a thread peer.

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
transaction with a fresh shared-protocol client; reply receipts and rollback stay per
tool call while storage expands segments into rows. Recognized adjacent splits and
merges and contiguous insertion or deletion runs stay one structural segment. Sharing
a paragraph alone never joins independent writes. A live write merges one update.

## Results and lifecycle

- `renderAgentEditResult` is the only path from typed result to model text. Hosts keep
  the typed value beside the rendered text and never parse text back.
- Echo text is verbatim and exact-matchable: truncation may drop a suffix but never
  normalizes what it keeps, because a whitespace-collapsing cleanup breaks the model's
  retry on text it was just shown (find-all deletion legitimately leaves double spaces).
- Provider tool IDs are response-local: idempotency scopes by response, then turn, then
  session, and a later response reusing an ID is a new attempt.
- Undo and redo are save boundaries: the host settles buffered writes before executing
  an inverse.
- An empty commit or rollback of an unknown response still closes it, so a late handler
  cannot reopen it.
- Copies pass nodes from host read results rather than reading source documents inside
  the kernel, so whitespace and blank paragraphs survive and copied blocks receive fresh
  identities.
- `move` and `delete` are on `WriteToolInputSchema` but not `WriteCommandSchema`: they
  change where a document lives, so the host runs them and reports through the same
  envelope.

[view]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/model-view.md
[reversal]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/agent-editing-and-reversal.md
