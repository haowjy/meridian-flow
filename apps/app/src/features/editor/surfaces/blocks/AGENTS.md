# Block movement surface

This surface moves one top-level block at a time. Handles and eligible object
bodies enter the same gesture, hold, drop calculation, and finalizer; the
surface owns no alternate drag state.

## Rules

- `blockSeams` exposes only top-level seams. A move refuses the two seams around
  the held block and replaces the last block with an empty paragraph when the
  schema requires one.
- Hold the block with `NodeHold`, never a position or child index. Keep the
  pointer's y and re-derive the seam after transactions and at drop.
- Handle and `block-drag` object-body presses share one kernel drag token.
  `inline-drag` objects remain ProseMirror's native drag path; table bodies
  refuse block dragging so cell selection keeps ownership. Do not teach this
  drag inline drop targets.
- The movable unit is a top-level block, so a seam can never land inside a
  table, figure, fence or list item. Nested reordering is a different design
  (`.context/FUTURE`), not a deeper hit-test. The body door opens only where the
  object is the whole block (`objectIsWholeBlock`); in a list item that also
  holds prose the press stays a text selection. It is mouse-only, and touch
  moves a block through the handle it taps.
- A picture travels by ProseMirror's own drag, landing between two words with
  the dropcursor (human ruling, 2026-07-29); its paragraph's margin handle
  still moves the whole line to a block seam. ProseMirror's HTML5 drag is
  refused for block objects, since re-parsing returned a figure as a bare
  paragraph.
- Never insert into or set attributes on the manuscript DOM (a widget between
  blocks shifts the page, and ProseMirror re-renders the attribute away); the
  lift is a decoration.
- Alt+↑/↓ moves the block but declines inside a table, where the table surface
  owns the keys for rows; a selected table still moves as an object.
- Both handle clicks (left and right, the `grip` claim rung) end in one open
  call. The menu's Turn into row exists only on text blocks and reuses the
  toolbar's `blockTypeRefusal` fence, shown greyed with a reason when refused;
  a move with nowhere to go is absent. Alignment lives on the toolbar, not the
  block menu. A list, quote or table has no Turn into row, so the menu converts a
  paragraph into a list but never back; un-listing lives on the toolbar.
- The handle owns the outer margin band and the table's row grips the inner one,
  disjoint by ruling; change one and the table surface's geometry is wrong.
- All termination paths—commit, cancel, refusal, pointer loss, suppression,
  and unmount—run through the shared finalizer. Do not add local timers,
  pointer listeners, or suppression state.
- The block handle is measured in manuscript-pane coordinates. It shares the
  outer margin band with table chrome and follows kernel hover/suppression;
  lanes do not place it in viewport coordinates.
- Touch uses the same held identity and drop geometry, with the surface's
  movement threshold. The menu is a chrome wrapper and acts on the held block.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for the transaction,
geometry, and termination contracts.
