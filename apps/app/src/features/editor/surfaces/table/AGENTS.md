# surfaces/table — the table's chrome

Everything a writer reaches on a table that is not typing in a cell: the row
and column grips outside the frame, the add tabs on the right and bottom
edges, the row/column/table menus, the header toggle, per-column alignment,
and the Alt+Arrow row and column moves.

At rest a table is just a table. Nothing here is inserted into the frame's DOM
and nothing here can move a line of the manuscript.

## Mental model

**A grip press makes a selection; every verb reads the selection.** That is
the whole design. Clicking a row grip selects the row, so "delete row" is
`deleteRow` over whatever is selected — the same command a swept cell
selection and the Alt+Arrow twin run. No verb takes a row index, so no verb
can act on a row the writer is not looking at, and the three doors into a verb
cannot drift apart. A menu outlives the press that opened it, so it holds what
it was opened on and rebuilds that selection as its verb runs.

The layers, in dependency order:

- [`table-commands.ts`](table-commands.ts) — the verb matrix. One answer per
  verb: applied, or the named reason it cannot run. Also the commands
  themselves, and the selection helpers the grips and tabs press.
- [`table-anchors.ts`](table-anchors.ts) — pointer → cell → document position,
  and cell → the viewport rects the chrome is positioned from.
- [`TableVerbMenu.tsx`](TableVerbMenu.tsx) — every menu's contents, and
  `tableMenuProps` which reads the verb matrix once per open.
- [`TableChrome.tsx`](TableChrome.tsx) — the mount: the approach lane, the
  portalled grips and tabs, the menus, the selected table's object row.

Column resize is **prosemirror-tables' `columnResizing`**, already mounted by
the table extension and styled to Q6 here. It writes `colwidth`, which is what
the `Layout widths` codec reads, so persistence needed no lane code. See
[`.context/CONTEXT.md`](.context/CONTEXT.md) for the evidence behind that call.

## Key rules

- **Elements are geometry, holds are identity.** The anchor is a `NodeHold` on
  the cell (`core/editor/anchors.ts`), carried across every transaction by
  `useNodeHold`; the element drawing that cell is resolved from it for each
  measurement. Neither half can be the other: a raw position is stale the moment
  a peer writes above the table, and an element belongs to DOM any rebuild may
  replace. Losing the CELL — scrolled out of the pane, or taken away by a peer —
  releases everything aimed at it, an open grip menu included: a menu that
  outlived its row would offer row verbs against whatever the selection has
  become. Losing only the element is not losing the cell.
- **One menu, one target, and the target is held.** A grip menu acts on the
  cell its grips serve; a swept rectangle acts on the two cells that describe it
  (`TableMenuTarget` in [`table-commands.ts`](table-commands.ts)). The verbs
  still read the selection, and `runTableVerbOn` is what makes that selection
  the writer's target: it materializes the held cells as the verb runs, and
  answers no when one of them is gone, which closes the menu rather than aiming
  it at whatever the selection has become. A menu the writer's own arrangement
  mounts — the caret's lists, the selected table's ⋮ — holds nothing, because it
  is unmounted by losing that arrangement rather than left pointing at it.
- **Grid coordinates, never child indices.** A merged cell makes `row.child(2)`
  and "column 2" different things. Every reading goes through `TableMap`, in
  [`core/editor/table-operations.ts`](../../../../core/editor/table-operations.ts).
- **A header row is a thing a table may not have** (§5.4 requirement 3). Ask
  `hasHeaderRow`; never treat row zero as structurally sacred, or a headerless
  table's first row becomes unreachable.
- **The kernel enforces keymap scope.** A `table`-scope binding only runs with
  a table in the context chain, so a lane guard re-asking the same question is
  a second answer waiting to drift.
- **Four menus, four things to act on**: a row, a column, the table, and a
  rectangle of cells the writer swept. The first three hang off chrome; the
  fourth is a right-click, because no grip can make an arbitrary rectangle and
  merging two adjacent cells has no other path.
- **A caret in a cell is the fifth arrangement, and it adds no verb.**
  `TableCaretMenuItems` is the Row and Column lists the grips already own,
  mounted inside the formatting menu the ladder's `caret` rung opens (human
  ruling, 2026-07-29). Export arrangements from here; never let another surface
  assemble its own list of table verbs.
- **Refusals are named, and the item says so** (law 5). A blocked verb passes
  its reason to the shared row as `blockedReason` and shows its label alone;
  the row greys it, swallows the select, and answers on hover or focus. This
  lane never wires that itself. New copy — including every reason — goes in
  [`table-copy.ts`](table-copy.ts); run extract and compile and commit both.
- **Availability comes from the command that will run.** `mergeCells` and
  `splitCell` answer for themselves. A control that looks live and does nothing
  is the dead control law 5 forbids.
- **Alt+Arrows are consumed inside a table even when refused.** Handing a
  refused row move down the ladder would move the whole table instead, which is
  not what a writer asked for by pressing "move this row".
- **Merging runs the cells' content together first, and refuses the header.**
  A cell holds one paragraph, and prosemirror-tables' merge appends every
  filled cell's content; the schema-fitted replace then splits the cell into a
  new row and drops what it could not fit. `mergeTableCells` joins first, uses
  the library's own structural emptiness test rather than `textContent`, and
  refuses a rectangle that spans the header row and the body.
- **The hover surface is the frame PLUS the bands the chrome hangs in.**
  Every piece is drawn outside the frame, so a hover that ends at the frame
  dismisses the grip the writer is travelling to, a few pixels before they
  reach it. `tableHoverZone` expands the table's rect by exactly what is drawn
  on each side; it holds a reveal, never starts one. Its left edge is the
  grips' half of the shared margin and stops one pixel short of the block
  handle's. It is this lane's `holds` predicate on the kernel's hover anchor —
  the one thing about this reveal the kernel cannot know.
- **Everything about the pointer except that zone is the kernel's.** This lane
  answers "which cell is at this point" and nothing else: the delay, the grace,
  the pointer's last place, the re-hit-test after a scroll, and the single
  hovered block all live in `core/editor/chrome/hover-anchor.ts`. A second
  answer here is how the grips once stayed up for a row the writer had
  scrolled past.
- **The reading handed to the coordinator is a hold, not a position.** It keeps
  a lane's last reading until the pointer moves again and re-delivers it
  whenever the manuscript moves underneath, so a position handed over is a
  position cached across a peer's write — and a peer's inserted row leaves a
  different, empty cell at that number. Measured: with a grip menu open on the
  writer's row, a re-delivered number moved the grips to the peer's new row the
  moment the menu closed.
- **Nothing this lane draws may reach the block below the table.** A click
  aimed at prose must never mutate a table (human ruling, 2026-07-29), and the
  seam between two blocks is 14.4px against an 18px tab — so the add-row tab
  sits inside the frame, and the hover zone's bottom band is derived from what
  is left there rather than from a gap. Changing either number means checking
  it against `.ProseMirror > * + *`.
- **Chrome that has left the manuscript's pane does not draw.** Placement is
  clipped to the scrollport in `table-anchors.ts`, so a grip cannot ride up
  over the toolbar when the writer scrolls without moving the pointer.
- The chrome portals out of the editor, so it carries `data-editor-chrome` or
  its right-clicks bypass the claim ladder.

## Anti-patterns

- A verb that takes a row or column index. Select, then run.
- Remembering what a menu acts on as a document position, an element, or the
  pointer's last screen point. A peer's inserted row leaves a DIFFERENT, empty
  cell at the number the pointer last read, and a remote write leaves a swept
  rectangle as a caret, so both readings are wrong exactly when a collaborator
  is writing.
- A pointer listener of this lane's own, of any kind. The grips are portalled
  outside the editor, a listener on the prose cannot see the pointer reach
  them, and pairing it with a React handler on the portal is a race the grips
  lose — but the fix is the kernel's one reading of the page, not a better
  listener here.
- Answering "the pointer is still on my chrome" by doing nothing. Not-leaving
  is not re-entering: the grace the frame's edge already scheduled still fires,
  and it fades the grip out from under the pointer resting on it. Saying so
  through `holds` is what cancels it.
- Following the document with a per-transaction re-render to learn whether a
  table is selected. The kernel's context store answers that, and notifies when
  the answer changes rather than on every keystroke of the chapter.
- Inserting anything into the table's DOM. Grips, tabs, and menus are portalled
  and measured, so the frame reserves nothing for them — which is what lets the
  add-row tab overlay the frame's own bottom edge without moving a cell.
- Reaching for prosemirror-tables' `toggleHeaderRow`. It toggles the SELECTED
  rows, so from the table's own menu it makes every row a header.
- Deciding a cell is empty by its text. A hard break and an inline image are
  content that carries no text.
- Clamping a piece of chrome back inside the pane. It would then point at a row
  it does not serve.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the primitives
→ [`../../../../core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md)
  for the seams and the Esc chain
→ design of record: `editor-toolbar-split/interaction-model.md` §5.4, §2 laws
  5 and 6; spans ruling 2026-07-29
