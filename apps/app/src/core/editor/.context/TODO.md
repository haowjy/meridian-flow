# Editor — TODO

These are verified open contracts, not implementation notes. Remove an entry
when the behavior and its probe land; do not turn completed work into history.

## Collaboration restart and detached status

`DocumentSession.restartTransport()` currently reuses the session-owned
Awareness after destroying a Hocuspocus provider. Provider destruction may also
destroy caller-supplied Awareness, so terminal recovery must either keep
provider/Awareness stable while replacing the socket or make ownership explicit.
Probe remote caret disappearance and restoration across terminal recovery.

An authorized editable session that remains `detached` without adoption failure
is not surfaced by `SyncStatus.tsx`. Add an honest signal without flashing
offline during a healthy cold load.

Affected paths: `document-session.ts` and `features/editor/SyncStatus.tsx`.

## Draft review

- Preserve cursor/selection deliberately across live and review remounts; scroll
  restoration is currently best effort.
- Consolidate remaining review entry/exit, preview, and fallback routing around
  the draft-review controller. Per-change commands, focus, and the change list
  already use the controller.

## Block identity probe

Add a probe that moves a figure and verifies every other block retains its hash
while the moved figure receives a fresh Yjs item identity. Keep schema changes
mirrored between this app schema and `packages/prosemirror-schema`.

## Task-list authoring

The shared schema and Markdown codec support `list_item.checked`, but no writer
surface can author or toggle it. A future surface should use existing
`list_item` plus `checked`, with an input rule, keymap, and checkbox DOM; do not
introduce upstream `taskList` or `taskItem` nodes.

## Two views of one session

- Image upload presence is currently published per editor. Concurrent uploads
  from two views can overwrite each other's token list; combine contributions at
  the session boundary if the product requires concurrent view uploads.
- Undo stacks are per editor but share the collaborative origin, so one view can
  undo the other. Change this only with an explicit product ruling.
