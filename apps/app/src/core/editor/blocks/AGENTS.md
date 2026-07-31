# core/editor/blocks — what the document knows about a block drag

One plugin, and it holds one thing: the block a pointer gesture has hold of,
and whether that gesture has lifted it. The gesture itself, the handle, the
drop line, and the menu are the surface's
([`features/editor/surfaces/blocks/`](../../../features/editor/surfaces/blocks/AGENTS.md)).

## Mental model

A drag is React's business right up until two things force it into the
document:

- **The manuscript has to show it.** A lifted block reads at half opacity
  (§5.8), and a decoration is the only way to style a node ProseMirror renders.
  Setting an attribute on the element by hand does not survive — the DOM
  observer treats an unexpected attribute change as corruption and re-renders
  the node without it.
- **The position has to survive the drag.** A peer's edit or an AI write can
  land while the pointer is down, because nothing gates a write (law 9). The
  block the writer grabbed has to be the block that lands, so it is held here,
  once, rather than in every consumer — as a `NodeHold`
  (`core/editor/anchors.ts`), because a remote write replaces the whole
  document and a mapped number would report the grab deleted every time.

## Key rules

- **The transactions carry meta only.** No step reaches Yjs, no undo entry
  appears for picking a paragraph up, and `addToHistory` is off. Picking a
  block up is not an edit.
- **A deleted block releases the hold.** The hold names the Yjs element behind
  the block, so a replacement standing where the block was is not the block,
  and the state clears rather than pointing at a stranger. The surface watches
  for that transition and ends its gesture on it: the document letting go is
  the last word.
- **The hold resolves on read, not in `apply`.** A plugin's `apply` runs while
  the Yjs binding may still be describing the document the transaction
  replaced; `draggedBlockPos` asks a settled state instead.
- **Nothing here reads the pointer.** It is told what happened; it never asks.

→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md) for the kernel that owns
  suppression and timing
→ design of record: `editor-toolbar-split/interaction-model.md` §5.8
