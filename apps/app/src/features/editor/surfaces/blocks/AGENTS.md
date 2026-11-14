# surfaces/blocks

Block handles and eligible object bodies enter one gesture, hold, drop calculation and
finalizer.

- The movable unit is a top-level block, so a seam never lands inside a table, figure,
  fence or quote; a list item is a block of its own, so a seam lands between items.
  Nested reordering is a different design ([FUTURE](.context/FUTURE)),
  not a deeper hit-test.
- Hold the block with `NodeHold`, not a position or child index, and re-derive the seam
  from the pointer's y after transactions and at drop.
- Inline pictures keep ProseMirror's native drag; table bodies refuse block dragging so
  cell selection keeps ownership.
- The lift is a decoration. Inserting into or setting attributes on the manuscript DOM
  fights ProseMirror.
- The handle owns the outer margin band and the table's row grips the inner one; keep
  them disjoint, or the table surface's geometry breaks.
- Every ending (commit, cancel, refusal, pointer loss, suppression, unmount) runs through
  the shared finalizer; local timers or pointer listeners leak a drag state it can't end.

Transactions, gesture doors, picture drag and placement:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
