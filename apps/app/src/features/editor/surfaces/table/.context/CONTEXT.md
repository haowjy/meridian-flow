# Table chrome — contracts

This reference covers table availability, identity-held targets, pane geometry,
and nested-table hover. Read [`AGENTS.md`](../AGENTS.md) first; core operations
remain in `core/editor/table-operations` and the mounted table plugin.

## Verb matrix

`tableVerbStates(state, { editable })` returns one `{ active, blockedBy }` per
verb. `table-copy.ts` maps reason codes to writer copy. Read-only/schema-fenced
state outranks structural reasons. Inserts, deletes, alignment, header toggle,
and placement are not blocked by merged spans; row/column moves are. Reflecting
verbs may be active while blocked so the writer can turn a state off.

The structural fences include header-first movement, table edges, merged cells,
single row/column, one-cell/non-rectangular/header-crossing merge selections,
and unset `colwidth` for reset widths. Alignment with no explicit value is
`null`, not an implicit left choice. A merge command also refuses a rectangle
that crosses header and body, both in menu availability and dispatch.

## Targets and menus

There are four menu target shapes: row axis, column axis, swept cells, and the
current table selection. Axis and swept targets hold `NodeHold` cell identity;
selection targets intentionally hold nothing. Materialize a held target into a
`CellSelection` only for evaluation or the command call. Never cache a position
or selection across peer transactions. A missing held cell closes its menu.

The cell-menu claim is the last context rung. `claimedSweptCells` answers the
actual cells covered by a rectangle, not merely its `from..to` range, so a
link, object, or grip keeps priority when appropriate. Nested-table reconcile
lets a held inner cell keep reveal while the pointer remains in its zone; a
fresh unrelated cell wins.

## Geometry and ownership

`tableChromePieces` receives table, hovered-column, and hovered-row rectangles
in manuscript-pane coordinates and returns pane-relative grip/tab boxes. The
pane clips them; there are no viewport fit tests or clamping rules. The expanded
`tableHoverZone` owns the gaps needed to reach a grip. The block handle occupies
the outer margin band; row grips occupy the inner band.

Chrome never overlaps prose. The add-row tab sits 6px inside the frame's
bottom edge because the gap between blocks (about 14px) is smaller than the
tab; check any change to either number against `.ProseMirror > * + *`. A grip
appears at the hovered row at once, with no transition on its position and no
scroll-driven re-measurement: it labels the row rather than travelling to it.

The kernel owns one hover/probe answer and re-hit-tests after layout changes.
This surface answers only which table cell is under its probe and whether the
pointer is in its expanded zone. It adds no pointer listener on the portal.
`NodeHold` plus `useAnchorRect` follows cell identity and geometry separately.
The selected table menu reads kernel context rather than a per-keystroke local
subscription.

Each grip forwards Radix trigger props. All menus use chrome layers and close
when their target disappears. Column resize remains prosemirror-tables'
`columnResizing` plugin and writes `colwidth` on the cells. Spanned or
multi-block cells use the markup codec's escalated table representation.
