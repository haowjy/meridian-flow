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

## Task-list authoring

The shared schema and Markdown codec carry a task item as `marker: "todo" | "done"` on the
block that starts the item, and the editor draws the box, but no writer surface can author
or toggle it. A surface should write `marker`, with an input rule (`[ ] `, `[x] `), a click
on the box and Mod-Enter, not upstream `taskList` or `taskItem` nodes.

## Editing lists

Lists are drawn and have plain commands (toolbar, Tab, `- `/`N. ` input rules). Not yet:
Enter in an item (a split copies `path` with its `|`, and `done` stays `done`), Enter or
Backspace to lift, paste and copy of lists as HTML (a pasted list is plain paragraphs), and
dragging an item with what is under it. Each item is one top-level block today, so a drag
moves one item.

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
