# surfaces/blocks — contracts

Reference depth for block movement. Read [`AGENTS.md`](../AGENTS.md) first.

## Seams and drops

`blockSeams(doc)` returns one position before every top-level block plus one
after the last, so a document with n blocks has n + 1 seams. Every seam
resolves at document depth by construction, which is the whole safety argument:
there is no seam inside a table, a figure, a fence, or a list item to drop into.

`moveBlockToSeamTransaction` refuses two seams — the ones on either side of the
block being moved. A writer who drops a paragraph back on its own edge asked
for nothing, and an undo entry for it would be a lie.

The seam is measured on the document BEFORE the lift, so a seam below the block
has to shift up by the block's size once it is removed. That single line is the
only arithmetic in the move.

## What travels with a block

| The writer was | After the move |
|---|---|
| a caret inside the block | the same offset inside it, wherever it landed |
| a text selection inside it | the same range |
| an object selection on it | still selected |
| a whole-table cell selection | still selected (a `NodeSelection` on a table normalizes back to one) |
| anywhere else | untouched |

Deleting the last block standing replaces it with an empty paragraph rather
than emptying the document: the schema needs a block and the writer needs
somewhere to type.

## The drag

The held position lives in the document, in
[`core/editor/blocks/`](../../../../../core/editor/blocks/index.ts), not in
React state. Two reasons, and the second is the one that bites: a peer's edit
or an AI write can land while the pointer is down (law 9 gates nothing), and
the block the writer grabbed has to be the block that lands. One mapped
position beats one per consumer.

A press becomes a drag only after 4px of travel — the same slop the kernel uses
for a sweep. Before that it is still a click, and telling the kernel otherwise
would blank every surface on the page for the length of a menu press.

Escape reaches a drag twice over. The kernel's chain calls the `onCancel`
handed to `beginDrag`, which covers a drag while the prose holds focus; a
window listener covers the rest, because a press that began on portalled chrome
may have left focus elsewhere and the chain never sees the key. Both doors call
one cancel.

## Geometry

| Piece | Anchored to |
|---|---|
| handle x | the prose column's left text edge, less a 12px gap and its own width |
| handle y | the block's first LINE (its padding plus half the leading), not its box |
| drop line | the prose column's edges, at the midpoint between two blocks |

`proseColumnEdges` is horizontal only, deliberately. The prose node reserves
half a viewport of padding under the last line so a writer can keep typing
mid-screen, so its box says nothing about where the manuscript ends. Hover is
judged against each block's own box instead, with 8px of slack so a pointer
crossing the gap between two paragraphs does not blink the handle off.

## Approach, and why the handle counts as the editor

The pointer spends the whole approach in the margin, where `posAtCoords` has
nothing useful to say, so x is pulled into the column before asking.

Travelling from the prose onto the handle reads to the DOM as leaving the
editor — and the browser delivers that leave AFTER the handle's own enter, so
a naive `leave()` undoes the reveal exactly as the writer arrives. Anything
carrying `EDITOR_CHROME_ATTRIBUTE` continues the approach instead. Any lane
whose chrome portals out of the scroller will need the same guard.

## The block menu

Opening it stands the writer on the block: a caret in prose, a node selection
on an object (law 1, a click reads). That is not decoration — it is what lets
`turn-into.ts` ask the toolbar's own predicates about a block the writer merely
pointed at, so both surfaces refuse the same targets for the same reasons.

Turn into is present only on text blocks (§5.8). The consequences are worth
naming: a list, a quote, or a table has no Turn into row, so the block menu
converts a paragraph INTO a list but never back. Un-listing lives on the
toolbar, whose control is lit when the caret is inside the list, and later on
the formatting menu. Alignment for text blocks is §5.1's line about the block
menu and is NOT here: ruling 15 put alignment on the persistent toolbar, and
one verb in two places is how the two documents disagree.
