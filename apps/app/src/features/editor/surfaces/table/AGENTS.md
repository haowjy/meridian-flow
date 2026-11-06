# Table chrome surface

Doors, targets, geometry and presentation over shared table commands.

- `tableVerbStates` is the one availability answer.
- A menu target is a held cell, not a stale position or copied selection, and closes when the cell
  disappears.
- Row and column moves refuse merged cells and header-crossing merges in the command as well as the menu.
- A click aimed at prose never mutates a table.
- Grips use pane coordinates from `tableChromePieces`. Pointer listeners or viewport fit tests here compete
  with the kernel's one hover answer.
- The block handle owns the outer margin band and row grips the inner band; keep them disjoint.
- Only this surface assembles table verbs; the formatting menu reuses the grips' lists.
- A table may have no header row: don't treat row zero as special or use `toggleHeaderRow` from the table
  menu.
- Alt+Arrows are consumed inside a table even when refused; passing a refused row move down would move the
  whole table.

Verb matrix, geometry, targets and nested tables: [`.context/CONTEXT.md`](.context/CONTEXT.md).
