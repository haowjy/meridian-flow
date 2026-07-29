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
| Selection spans the header row and the body | merge cells | `header-and-body` |
| More than one cell selected | split cell | `many-cells-selected` |
| One cell selected, carrying no span | split cell | `not-merged` |
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

`tableChromePieces` is the whole placement decision: a pure function of four
rectangles — the table, the hovered column band, the hovered row band, and the
manuscript's scrollport — returning a box per piece, or null where the piece
would fall outside the port. Sizes live there too, not in CSS: the module that
decides whether a grip fits has to know how big it is.

| Piece | Placement |
|---|---|
| Column grip | 30×15 pill, centred on the hovered column, bottom edge 4px above the table |
| Row grip | 15×30 pill, centred on the hovered row, right edge 6px left of the table |
| Add column tab | 18px circle, 9px right of the table's right edge, vertically centred |
| Add row tab | 18px circle, 9px below the table's bottom edge, horizontally centred |

**Null rather than clamped.** A grip pushed back inside the port would sit
beside a row it does not serve, and chrome pointing at the wrong row is worse
than chrome that is not there. The document toolbar needs no special case: it
lives above the scrollport rather than inside it, so anything that would ride
up over it has already left the port. A grip keeps its element while out of
view — Radix needs a trigger to anchor an open menu to — and stops painting
and hit-testing; the add tabs simply unmount.

When the hovered cell itself leaves the port — scrolled away, or taken by a
peer deleting the row — the anchor is released whole: hover intent cancelled,
anchor dropped, and any open grip menu closed with it. Closing the menu is the
load-bearing part. An open menu holds the anchor still so a stray hover cannot
move the grips out from under it, so a menu that outlived its own row would
pin the surface to a dead element and no later hover could replace it: the
table's chrome never came back.

Opacity on the container fades all four together. Opacity makes a stacking
context but **not** a containing block, so the fixed children still resolve
against the viewport — do not add `transform` or `will-change` to that
container or every grip will jump to the wrong place.

Rects are re-measured on capture-phase scroll (the manuscript scrolls in a pane,
not the window), on resize, on a `ResizeObserver` over the cell and the table,
and on every editor transaction: a row grows as the writer types into it and
the grip has to travel with it.

## The four menus, and who takes a right-click

| Shape | Door | Carries |
|---|---|---|
| Row | row grip, left-click or right-click | insert, merge/split, move, delete, `Table ▸` |
| Column | column grip, either button | insert, alignment, merge/split, move, delete, `Table ▸` |
| Cells | right-click inside a swept rectangle | merge/split, alignment, `Table ▸` |
| Table | the selected table's ⋮ | header row, alignment, placement, widths, delete |

The cell menu is deliberately the shortest. Merge and split are what a
rectangle exists for, alignment applies to the columns it covers, and the row
and column verbs already have a home on the grips a few pixels away; a third
copy of them would be three places saying the same thing.

`cell-selection` is the ladder's last rung, added because nothing above it
wanted a `CellSelection`: `proseSelectionCovers` admits `TextSelection` and
`AllSelection` only, so the formatting menu stands down, a grip is chrome
rather than a cell, and `objectSurfaceKind` returns null for a table. A swept
rectangle therefore reached no menu at all. Last is the right place for it: a
link inside a selected cell is still a link, and a grip drawn over one is
still a grip.

`claimsTableCellMenu` decides it, pure and testable. It asks whether the
pointer is inside one of the cells the selection COVERS, not whether it falls
in the selection's `from`..`to` range: a rectangle two columns wide in a
four-column table spans cells it does not contain.

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

## Merging under a one-paragraph cell

`mergeTableCells` runs the filled cells' inline content together into one
paragraph before handing the selection to prosemirror-tables. Three things it
has to get exactly right, each of which was a defect first:

- **Emptiness is structural**, and it is the library's own test: one childless
  text block. `textContent` disagrees about a cell holding only a hard break or
  only an inline image, and a cell the two disagree about is one whose content
  the join leaves behind and the merge then appends as a second paragraph —
  which the schema fit ejects out of the table entirely.
- **Every block of every cell**, in reading order, and each cell's WHOLE
  content is replaced. Reading only `firstChild` loses the rest the moment a
  cell can hold more than one paragraph.
- **The header row does not merge into the body** (`mergeCrossesHeader`).
  Upstream merges any rectangle and keeps the first cell's type, so a
  whole-column merge on a headed table yields one header cell spanning every
  row. The fence is in the command as well as the menu. Merging the header row
  across itself stays allowed: that is a title row.

When cells hold several paragraphs on the wire, loosen
`table_cell`/`table_header` to `paragraph+` (a minor collab-schema bump: the
change only loosens) and delete the join; `mergeCells` then stands alone.

## What the wire cannot carry yet

**Spans** are on the wire now (the codec escalates a spanned table to raw
HTML), and so are span-sized `colwidth` arrays — see the widths ruling in
[`packages/markup/.context/CONTEXT.md`](../../../../../../../../packages/markup/.context/CONTEXT.md).
What remains absent is **multi-paragraph cells**, which is why the merge joins
text rather than stacking paragraphs.

## Where the lane touched shared code

- `core/editor/table-operations.ts` — grid coordinates, header awareness,
  `toggleTableHeaderRow`, `mergeTableCells`, `setTablePlacement`,
  `resetTableColumnWidths`. `resetTableLayout` was deleted: it had no consumer
  and conflated placement with widths, which the menu offers separately.
- `core/editor/chrome/` — the Esc chain's fourth step (prose inside an object
  steps out onto the object) and `ChromeContext.objectPos` behind it.
- `features/editor/chrome/OverlayIconRow.tsx` — the overflow chip forwards its
  props, so it can actually be a menu trigger.
