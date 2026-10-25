# Block movement surface

Moves one top-level block at a time. Handles and eligible object bodies enter
the same gesture, hold, drop calculation and finalizer; the surface owns no
alternate drag state.

- The movable unit is a top-level block, so a seam never lands inside a table,
  figure, fence or list item. Nested reordering is a different design
  ([FUTURE](.context/FUTURE)), not a deeper hit-test.
- Hold the block with `NodeHold`, never a position or child index; re-derive
  the seam from the pointer's y after transactions and at drop.
- Handle and `block-drag` object-body presses share one kernel drag token.
  Inline pictures keep ProseMirror's native drag; table bodies refuse block
  dragging so cell selection keeps ownership.
- Never insert into or set attributes on the manuscript DOM; the lift is a
  decoration.
- Alt+↑/↓ moves the block but declines inside a table, where the table surface
  owns those keys.
- The handle owns the outer margin band and table row grips the inner one; keep
  them disjoint, or the table surface's geometry breaks.
- Every ending (commit, cancel, refusal, pointer loss, suppression, unmount)
  runs through the shared finalizer. Add no local timers, pointer listeners or
  suppression state.
- The handle is measured in manuscript-pane coordinates, never viewport
  coordinates.

Transactions, gesture doors, picture drag, the handle menu and placement:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
