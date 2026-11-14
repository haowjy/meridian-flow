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
