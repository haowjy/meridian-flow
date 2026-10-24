# surfaces/blocks — contracts

This reference covers top-level block movement: identity, seams, gesture
termination, and pane-relative placement. Read [`AGENTS.md`](../AGENTS.md)
first; core drag policy remains in `core/editor/blocks` and the chrome kernel.

## Identity and transactions

`blockSeams(doc)` returns one seam before each top-level block and one after the
last. `moveBlockToSeamTransaction` refuses the two seams surrounding the held
block. The seam is measured before lifting; only a seam below the block is
shifted by the removed block size. Moving the final block leaves an empty
paragraph because the schema requires a block.

The gesture holds a `NodeHold` from `holdBlock`. A mapped position or child
index is invalidated by peer/AI writes and can name a different block. The
pointer's y is intent; the rendered seam beneath it is re-read after each
transaction and once more at drop. The drop target is never stored.

The transaction maps the writer's selection through the move. Carets,
selections, object selections, and whole-table cell selections remain attached
to the moved block; unrelated selections are untouched.

## Gesture doors and termination

The margin handle and eligible object bodies enter `block-gesture.ts` and share
one hold, kernel drag token, and finalizer. `EDITOR_OBJECT_TYPES.body` decides
whether an object uses `block-drag`, `text`, or `inline-drag`; inline objects
remain ProseMirror's native drag path and table cells retain cell-selection
ownership.

The finalizer covers commit, cancel, refusal, pointer loss, suppression, and
unmount. It releases the hold and kernel token exactly once. Suppression is
kernel-owned, and this surface adds no timer or independent pointer state. Touch
uses the same identity and seam calculation after its movement threshold.

A picture travels by ProseMirror's own drag, landing between two words with
the dropcursor; its paragraph's margin handle still moves the whole line to a
block seam. ProseMirror's HTML5 drag is refused for block objects because
re-parsing the dropped HTML turns a figure into a bare paragraph.

The handle's menu (left or right click, the `grip` claim rung, both ending in
one open call) offers Turn into only on text blocks, reusing the toolbar's
`blockTypeRefusal` fence and greying with a reason when refused; a move with
nowhere to go is absent. Alignment lives on the toolbar. A list, quote or table
has no Turn into row, so the menu turns a paragraph into a list but never back;
un-listing lives on the toolbar.

## Placement

The handle and drop line are measured in the manuscript pane and clipped by
that pane. They do not use viewport-fixed coordinates. `block-geometry.ts`
reads the block's own box; blank past-the-end prose is not a block target.
The block handle owns the outer margin band; table row grips use the inner band.
Keep those bands disjoint when changing either surface.

Chrome is registered through the shared hover/drag lanes. The context menu acts
on the held block and uses the standard `EditorMenu` layer/focus contract.
