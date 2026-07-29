# surfaces/table — the table's chrome

Everything a writer reaches on a table that is not typing in a cell: the row
and column grips outside the frame, the add tabs on the right and bottom
edges, the row/column/table menus, the header toggle, per-column alignment,
and the Alt+Arrow row and column moves.

At rest a table is just a table. Nothing here renders inside the frame and
nothing here can move a line of the manuscript.

## Mental model

**A grip press makes a selection; every verb reads the selection.** That is
the whole design. Clicking a row grip selects the row, so "delete row" is
`deleteRow` over whatever is selected — the same command a swept cell
selection and the Alt+Arrow twin run. No verb takes a row index, so no verb
can act on a row the writer is not looking at, and the three doors into a verb
cannot drift apart.

The layers, in dependency order:

- [`table-commands.ts`](table-commands.ts) — the verb matrix. One answer per
  verb: applied, or the named reason it cannot run. Also the commands
  themselves, and the selection helpers the grips and tabs press.
- [`table-anchors.ts`](table-anchors.ts) — pointer → cell → document position,
  and cell → the viewport rects the chrome is positioned from.
- [`TableVerbMenu.tsx`](TableVerbMenu.tsx) — the three menus' contents.
- [`TableChrome.tsx`](TableChrome.tsx) — the mount: hover tracking, the
  portalled grips and tabs, the menus, the selected table's object row.

Column resize is **prosemirror-tables' `columnResizing`**, already mounted by
the table extension and styled to Q6 here. It writes `colwidth`, which is what
the `Layout widths` codec reads, so persistence needed no lane code. See
[`.context/CONTEXT.md`](.context/CONTEXT.md) for the evidence behind that call.

## Key rules

- **Grid coordinates, never child indices.** A merged cell makes `row.child(2)`
  and "column 2" different things. Every reading goes through `TableMap`, in
  [`core/editor/table-operations.ts`](../../../../core/editor/table-operations.ts).
- **A header row is a thing a table may not have** (§5.4 requirement 3). Ask
  `hasHeaderRow`; never treat row zero as structurally sacred, or a headerless
  table's first row becomes unreachable.
- **Refusals are named, and the item says so** (law 5). A blocked menu item
  keeps its hover and focus, wears `aria-disabled`, drops its action, and
  carries the reason on a second line. `disabled` is where a reason goes to
  die. New copy — including every reason — goes in
  [`table-copy.ts`](table-copy.ts); run extract and compile and commit both.
- **Availability comes from the command that will run.** `mergeCells` and
  `splitCell` answer for themselves. A control that looks live and does nothing
  is the dead control law 5 forbids.
- **Alt+Arrows are consumed inside a table even when refused.** Handing a
  refused row move down the ladder would move the whole table instead, which is
  not what a writer asked for by pressing "move this row".
- **Merging runs the cells' text together first.** A cell holds one paragraph,
  and prosemirror-tables' merge appends every filled cell's content; the
  schema-fitted replace then splits the cell into a new row and eats a cell's
  text. `mergeTableCells` joins first. This goes away when cells hold several
  paragraphs on the wire.
- The chrome portals out of the editor, so it carries `data-editor-chrome` or
  its right-clicks bypass the claim ladder.

## Anti-patterns

- A verb that takes a row or column index. Select, then run.
- Hover timing from a local `setTimeout` instead of `chrome.createHoverIntent`.
- Rendering anything inside the table. Grips, tabs, and menus are portalled and
  measured; the frame stays clean.
- Reaching for prosemirror-tables' `toggleHeaderRow`. It toggles the SELECTED
  rows, so from the table's own menu it makes every row a header.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the primitives
→ [`../../../../core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md)
  for the seams and the Esc chain
→ design of record: `editor-toolbar-split/interaction-model.md` §5.4, §2 laws
  5 and 6; spans ruling 2026-07-29
