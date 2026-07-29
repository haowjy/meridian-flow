# Table chrome — contracts and the calls behind them

Reference depth for the table surface. Read [`AGENTS.md`](../AGENTS.md) first.

## The verb matrix

`tableVerbStates(state, { editable })` maps the selection to one
`{ active, blockedBy }` per verb. Reasons are codes; `table-copy.ts` turns them
into writer copy, so the same code can read differently per verb.

| Context | Blocked verbs | Reason code |
|---|---|---|
| Selection outside any table | all | `no-table` |
| Read-only host or schema fence | all | `document-read-only` |
| Selection is on the header row | insert row above, move row up, move row down | `header-row-first` |
| First or last row/column in the move's direction | that move | `at-table-edge` |
| Any merged cell anywhere in the table | all four moves | `merged-cells` |
| One row left | delete row | `single-row` |
| One column left | delete column | `single-column` |
| A caret rather than a cell selection | merge cells | `one-cell-selected` |
| Cell selection that is not a rectangle | merge cells | `cells-not-rectangular` |
| Cell carries no span | split cell | `not-merged` |
| No cell carries a `colwidth` | reset column widths | `no-column-widths` |

Read-only outranks every structural reason: on a document the writer cannot
change, saying so once is the honest answer.

Inserts, deletes, alignment, the header toggle, and placement are never blocked
by a span — only the four moves are, because reordering rows or columns by
index across a merged cell corrupts the grid. `active` is computed for the
reflecting verbs (alignment, header, placement) even where something is
blocked: what is on can always come off.

**Alignment reports unset as unset.** A column nobody has aligned reads in the
reading direction and has not been decided, which is different from a column
decided to be left. The radio group shows no choice made; `null` is a value.

## Geometry

All four pieces of chrome are `position: fixed`, portalled to the body, and
measured from the hovered cell plus the table's own box. Measured in the
browser against mockup 05, with the manuscript's block offsets byte-identical
with the chrome up and down:

| Piece | Placement |
|---|---|
| Column grip | 30×15 pill, centred on the hovered column, bottom edge 4px above the table |
| Row grip | 15×30 pill, centred on the hovered row, right edge 6px left of the table |
| Add column tab | 18px circle, centre 18px right of the table's right edge, vertically centred |
| Add row tab | 18px circle, centre 18px below the table's bottom edge, horizontally centred |

Opacity on the container fades all four together. Opacity makes a stacking
context but **not** a containing block, so the fixed children still resolve
against the viewport — do not add `transform` or `will-change` to that
container or every grip will jump to the wrong place.

Rects are re-measured on capture-phase scroll (the manuscript scrolls in a pane,
not the window), on resize, on a `ResizeObserver` over the cell and the table,
and on every editor transaction: a row grows as the writer types into it and
the grip has to travel with it.

## Hover and the menus

Hover intent comes from `chrome.createHoverIntent`, keyed on the cell ELEMENT
so an unchanged cell settles once rather than on every `mousemove`. The chrome
container re-enters the intent on `mouseenter`, which is what lets the pointer
cross from the table onto a grip without the reveal dying in the gap.

While a menu is open the anchor is frozen: a stray hover would slide the grips
out from under the menu and leave it pointing at another row. On close the
pointer's real position is read back from `intent.settled`, or the chrome
lingers where the writer left it.

Each grip is its own Radix trigger, so nothing here uses the pointer anchor.
`GripButton` composes Radix's injected `onPointerDown` rather than replacing
it: the selection is armed first, then the library opens.

## Column resize: the plugin, not our own (verdict)

prosemirror-tables' `columnResizing` was already mounted by
`MeridianTable.configure({ resizable: true })`. It was kept. Evidence from the
browser:

- **Hover-only.** The handle is a widget decoration the plugin adds only while
  the pointer is within `handleWidth` (5px) of a boundary, and removes on the
  next `mousemove` away.
- **Zero layout shift**, after one fix. The widget is `position: absolute`
  inside the cell, so it takes no space — but it is a real DOM sibling, so the
  cell's paragraph stopped being the last child and its 8px bottom margin came
  back, growing every row in the column. `td > p:last-of-type` ignores the
  widget (it is a `div`), and the cell measures 41px with the hairline up and
  down.
- **Widths persist where the codec reads them.** A drag writes `colwidth: [n]`
  on every cell of the column via `setNodeMarkup`; `Layout`'s `widths` prop is
  serialized from the first row's `colwidth`. Measured: a 70px drag produced
  `[266]` on all six cells of the column and `<col style="width: 266px">`.

Owning resize would have bought nothing and cost a drag implementation, a drop
of the plugin's spanned-column arithmetic, and a second place widths are
written.

## What the wire cannot carry yet

Two things the editor now does that `packages/markup` refuses or drops. Both
belong to the codec escalation, and both are loud rather than silent today
except where noted:

- **Spans** throw on serialize (`table cell spans are not representable in
  GFM`). Ruled allowed in the editor; the wire follows.
- **`colwidth` on a spanned cell** is written as `[0, n]` by the resize plugin
  (`zeroes(colspan)`), which the codec rejects as "must be null or one positive
  integer". Only reachable by resizing a column that contains a merged cell.
- **Multi-paragraph cells** do not exist yet: the schema allows one paragraph,
  which is why `mergeTableCells` joins text instead of stacking paragraphs.
  When the codec learns multi-line cells, loosen `table_cell`/`table_header` to
  `paragraph+` (a minor collab-schema bump: the change only loosens) and delete
  the join.

## Where the lane touched shared code

- `core/editor/table-operations.ts` — grid coordinates, header awareness,
  `toggleTableHeaderRow`, `mergeTableCells`, `setTablePlacement`,
  `resetTableColumnWidths`. `resetTableLayout` was deleted: it had no consumer
  and conflated placement with widths, which the menu offers separately.
- `core/editor/chrome/` — the Esc chain's fourth step (prose inside an object
  steps out onto the object) and `ChromeContext.objectPos` behind it.
- `features/editor/chrome/OverlayIconRow.tsx` — the overflow chip forwards its
  props, so it can actually be a menu trigger.
