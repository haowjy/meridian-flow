# Table chrome surface

Table grips, menus, placement controls and resize-adjacent chrome. Core table
operations and the verb matrix live in shared command modules; this directory
supplies doors, targets, geometry and presentation.

- `tableVerbStates` is the one availability answer. Read-only outranks
  structural reasons, and an active verb can always be turned off.
- A menu target is a held cell or identity, never a stale position or copied
  selection. Commands evaluate and run against that same target.
- Row and column moves refuse merged cells and header-crossing merges, in the
  command as well as the menu. Unset alignment stays `null`.
- Chrome never overlaps prose, and a click aimed at prose never mutates a
  table.
- Grips and add tabs use pane coordinates from `tableChromePieces`; the pane
  clips them. Add no pointer listeners or viewport fit tests.
- The block handle owns the outer margin band and row grips the inner band;
  keep them disjoint. Column resize stays the prosemirror-tables plugin,
  writing canonical `colwidth`.
- Only this surface assembles table verbs; the formatting menu reuses the
  grips' lists (`TableCaretMenuItems`). Every menu uses chrome wrappers and
  closes when its held cell disappears.
- A table may have no header row: never treat row zero as special or use
  `toggleHeaderRow` from the table menu.
- Alt+Arrows are consumed inside a table even when refused; passing a refused
  row move down would move the whole table.

Verb matrix, geometry, targets and nested tables:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
