# Editor — TODO

## Detached status

An authorized editable session that stays `detached` without adoption failure is
not surfaced by `SyncStatus.tsx`. Add an honest signal without flashing offline
during a healthy cold load.

## Draft review

Preserve cursor and selection across live and review remounts; scroll restoration
is best effort.

## Block identity probe

Add a probe that moves a figure and verifies every other block keeps its hash
while the moved figure receives a fresh Yjs item identity.

## Lists and screen readers

List markers are generated content on flat sibling blocks, with `aria-level` on each listed
block; there is no `role="list"` parent. What VoiceOver and NVDA announce is untested. If
they do not read a list, the fallback is a visually hidden text marker in a widget
decoration (flat model design, section 7).

## Two views of one session

- Concurrent image uploads from two views can overwrite each other's token list.
  Combine contributions at the session boundary if the product requires them.
- Both views share the session's one undo stack (`DocumentSession.history`), so Ctrl+Z in
  either view reverts the writer's last edit in the document, whichever view made it.

## Unsent edits in a detached session

`hasUnacknowledgedEdits()` reads the transport provider, so an edit written into a retained
session whose socket is detached (no editor, e.g. an upload finishing) does not count as
unsent. The registry can then retire the session without holding it for delivery. Check
whether local persistence alone carries that edit to the server on the next open; if not,
count local-only updates as unsent while detached.

## Composition undo grouping

Delayed IME composition can create separate undo entries for provisional and
committed text: `ni` → `你`, with more than 500ms between updates, undoes first to
`ni`, then to the original text. This occurs in ordinary prose as well as beside
objects. Follow up after the native-selection fixes from PR #1573:
group the composition as one user action rather than depending on capture timing.

## Cell selection restoration

A peer edit elsewhere in a document turns a full-table CellSelection into a
TextSelection over its head cell; the table ring disappears and typing can replace
that cell's text. This also happens with native caret projection disabled.
`getRelativeSelection` in y-tiptap records the `cell` type but uses the selection's
text endpoints; `restoreRelativeSelection` handles only all/node/nodeRange and
falls back to TextSelection for cells. Preserve the cell boundary endpoints and
selection type at that binding boundary, including partial selections, deleted or
moved cells and Undo restore. Reproduce with two tabs: select the whole table in
one, type in a following paragraph in the other, then inspect or type in the first.

The same selection has two different extents: its cells cover a rectangle, while
its native `$anchor`/`$head` cover only the head cell. A table that ends the document
therefore narrows to its head-cell text on Shift+PageDown or Ctrl+Shift+Right when
the browser makes no move after native range preparation. No text changes. Solve
this representation issue with restoration, not per-key boundary guards. If the
fix separates a whole-table NodeSelection from cell ranges, get a design-lead
review before changing those semantics.
