# core/editor/blocks — what the document knows about a block drag

One plugin holding the block a pointer gesture has hold of and whether it has been
lifted. Why it lives in the document is in `BlockDragExtension.ts`; the gesture,
handle, drop line and menu are the
[surface's](../../../features/editor/surfaces/blocks/AGENTS.md).

- The hold names the block id, so a replacement standing where the block was doesn't
  inherit it, and a block a peer moves keeps it. The record outlives a deleted block
  (an undo that restores the id brings the drag back); the drag ends once a pointer
  move or the drop finds no block, never from a `transaction` listener: that runs
  inside the gesture's own begin and lift dispatches.
- The hold resolves on read, not in `apply`: a plugin's `apply` runs while the
  binding may still describe the document the transaction replaced.
