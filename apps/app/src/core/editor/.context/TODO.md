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
objects. Group the composition as one user action rather than depending on
capture timing.

## Whole-table selection extent

A whole-table CellSelection has two different extents: its cells cover a rectangle, while
its native `$anchor`/`$head` cover only the head cell. A table that ends the document
therefore narrows to its head-cell text on Shift+PageDown or Ctrl+Shift+Right when
the browser makes no move after native range preparation. No text changes. Peer restoration now preserves cell selections, but does not fix this
representation mismatch. Do not add per-key boundary guards. A proposal to
separate whole-table NodeSelection from cell ranges changes what writers select
and what typing replaces; take that design to the product lead for review first.

## Upstream projection hook

The owner will submit the prepared `selectionForDOM` proposal linked from the
[patch contract](CONTEXT.md#interaction-mechanics-and-recovery) to ProseMirror's
replacement tracker. Both GitHub trackers are archived; filing is blocked on a
tracker account. The proposal is not an upstream issue or an endorsement. Keep
this task until the submitted issue is linked from that contract.
