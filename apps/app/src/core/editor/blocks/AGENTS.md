# core/editor/blocks — what the document knows about a block drag

One plugin holding the block a pointer gesture has hold of and whether it has been
lifted. Why it lives in the document is in `BlockDragExtension.ts`; the gesture,
handle, drop line and menu are the
[surface's](../../../features/editor/surfaces/blocks/AGENTS.md).

- A deleted block releases the hold. The hold names the Yjs element, so a replacement
  standing where the block was doesn't inherit it. The surface ends its gesture on
  that transition.
- The hold resolves on read, not in `apply`: a plugin's `apply` runs while the Yjs
  binding may still describe the document the transaction replaced.
