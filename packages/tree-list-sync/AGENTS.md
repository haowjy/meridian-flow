# @meridian/tree-list-sync

How a client keeps its copy of a project's tree list the server's, over the Yjs socket. Used by
the browser (`apps/app/src/core/tree-list`) and by the server's room tests.

- `connectTreeList` owns the provider and the socket and nothing else: the copy, its storage and
  its tabs come in through `ListCopy`.
- What the client sends goes in parts of `PART_RECORDS` records (an eighth of the admission's
  cap, `MAX_RECORDS` in `project-tree`; `splitSyncFrame`), so no honest client meets that cap on
  one update. A limit an honest client can reach is never a whole refusal. The server sends
  whole: a browser has no limit on an update.
- The state follows the code of the socket's close: `4212` (the server found the copy does what
  an honest client never does) loads a fresh copy and appends the old copy's unsent records once,
  those `clientMayWrite` accepts (the rest go to `onDropped`); a second `4212` before the server
  took them is `broken`, and nothing connects again. `4213` (the copy is of another list) loads an
  empty copy and carries nothing. `4401` and `4403` are `denied`; any other close reconnects.
- The socket's URL carries `?list=<id>` (`ListCopy.listId`); a copy with none learns it from the
  room's stateless `{"list": id}` message.
- The records a recovery carries live in the `ListCopy` (`carried`, `settleCarried`), stored
  durably by the browser's copy: the connection forgets them once the fresh copy holds them.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
