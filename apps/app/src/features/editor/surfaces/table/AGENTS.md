# Table chrome surface

This lane owns table grips, menus, placement controls, and resize-adjacent
chrome. Core table operations and the verb matrix remain in shared command
modules; this directory supplies doors, targets, geometry, and presentation.

- `tableVerbStates` is the one availability answer. Read-only status outranks
  structural reasons; active reflecting verbs may still be turned off.
- The four menu targets are row axis, column axis, swept cells, and the
  current table selection. A target is a held cell/identity, never a stale
  position or copied selection. Materialize it for command evaluation without
  dispatching; commands then run against that same target.
- Row and column moves refuse merged cells and header-crossing merges. The
  header fence exists in the command as well as the menu. Preserve unset
  alignment as `null`.
- Grips and add tabs use pane coordinates from `tableChromePieces`; the pane
  clips them. Hover uses the expanded table zone, kernel ownership, and
  `NodeHold` reconciliation for nested tables. Do not add pointer listeners or
  viewport fit tests.
- The block handle owns the outer margin band; table row grips own the inner
  band. Keep the bands disjoint. Table resize remains the mounted
  prosemirror-tables plugin and writes canonical `colwidth` values.
- Every menu uses chrome wrappers and closes when its held cell disappears.
- Chrome never overlaps prose and a click aimed at prose must never mutate a
  table (human ruling, 2026-07-29): the add-row tab sits 6px inside the frame's
  bottom edge because the gap between blocks (about 14px) is smaller than the
  tab. Check any change to either number against `.ProseMirror > * + *`.
- A grip is a label on the hovered row, not a thing that travels to it (human
  ruling, 2026-07-30): it appears at the row at once, with no transition on its
  position and no scroll-driven re-measurement.
- There are four menus (row, column, swept cells by right-click, selected
  table). A caret in a cell adds no verb: `TableCaretMenuItems` reuses the
  grips' Row and Column lists inside the formatting menu. Never let another
  surface assemble its own table verbs. A table may have no header row; never
  treat row zero as sacred or use `toggleHeaderRow` from the table menu.
- Alt+Arrows are consumed inside a table even when refused; passing a refused
  row move down would move the whole table.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for the verb matrix,
geometry, target, and nested-table contracts.
