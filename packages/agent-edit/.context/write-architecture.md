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
