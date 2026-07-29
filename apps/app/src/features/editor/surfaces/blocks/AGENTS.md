# surfaces/blocks — block movement

The margin handle, the drag with its jade drop line, the block menu, and
Alt+↑/↓ (§5.8). One surface, because they are one verb with four doors: every
one of them ends in the same transaction.

## Mental model

**The movable unit is a top-level block** — a direct child of the document.
That choice is load-bearing rather than a simplification: a seam between two
top-level children can never land inside a table, a figure, a fence, or a list
item, so "never drop inside a protected node" is a property of the geometry
instead of a check somebody has to remember. The handle in the margin points at
the same unit, so what the writer aims at and what lands are one thing.

Three layers, and nothing crosses:

- `block-targets.ts` — positions and transactions, pure over `EditorState`.
- `block-geometry.ts` — what the browser drew: the margin, the seam under the
  pointer, where the line goes.
- `BlockMovementSurface.tsx` — the gesture. It decides nothing about the
  document and nothing about timing.

The document's own memory of a drag lives in
[`core/editor/blocks/`](../../../../core/editor/blocks/index.ts): which block a
gesture is holding, and whether it has lifted.

## Key rules

- **Nothing here keeps a timer or a suppression rule.** Hover comes from
  `chrome.createHoverIntent`, a drag is declared with `chrome.beginDrag`, and
  the kernel cancels the reveal when a gesture starts. A local `setTimeout`
  would linger through a drag.
- **Overlays are measured onto the page, never inserted into it** (law 7). A
  widget decoration between two blocks inherits the manuscript's block spacing
  and pushes the page down by its own height.
- **The manuscript's DOM is ProseMirror's.** Styling a block by setting an
  attribute on its element does not survive: the DOM observer treats it as
  corruption and re-renders the node without it. The lift is a decoration.
- **Alt+↑/↓ declines inside a table.** The same keys move rows there and the
  table surface owns them (§4, deepest owner). A selected table still moves —
  it is an object, and the writer selected the whole thing.
- **Turn into borrows the toolbar's fence** (`blockTypeRefusal`,
  `codeBlockRefusal`, `blockTypeReasonMessage`). A figure that cannot become a
  heading must be unable to from every door, and one rule is how that stays
  true.
- **Two law-5 shapes.** A move with nowhere to go is absent; a conversion the
  schema refuses is present with its reason in view. Menu items may take
  Radix's `disabled` because the reason is rendered text, not a tooltip — the
  toolbar greys instead only because its reasons live in tooltips.
- **Reach the chrome primitives by module, not through `chrome/index.ts`.**
  That barrel also carries the surface registry this lane is listed in, so the
  round trip is a module cycle.

## Anti-patterns

- Resolving the movable block by walking to the deepest node under the pointer.
  Nested reordering is a different design (see `.context/FUTURE`).
- A second refusal rule for whole-block conversions.
- Mounting anything in `EditorView.tsx` or reading suppression into local state.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md)
→ [`../toolbar/AGENTS.md`](../toolbar/AGENTS.md) for the fence this reuses
→ design of record: `editor-toolbar-split/interaction-model.md` §5.8, §2 laws
  1, 4, 5, 6, 7
