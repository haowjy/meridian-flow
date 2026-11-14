# @meridian/tree-list-sync

How a client keeps its copy of a project's tree list the server's, over the Yjs socket. Used by
the browser (`apps/app/src/core/tree-list`) and by the server's room tests.

- `connectTreeList` owns the provider and the socket and nothing else: the copy, its storage and
  its tabs come in through `ListCopy`.
- What the client sends goes in parts of `PART_RECORDS` records (an eighth of the admission's
  cap, `MAX_RECORDS` in `project-tree`; `splitSyncFrame`), so no honest client meets that cap on
  one update. A limit an honest client can reach is never a whole refusal. The server sends
  whole: a browser has no limit on an update.
- The state follows the code of the socket's close: `4210` (the server refused the copy whole)
  replaces the copy, the new one syncs under a new Yjs client id, and the records it lacks are
  appended again in one update. `4401` and `4403` are `denied`; any other close reconnects.
  The server's close names the record it refused (`list-rebuild:<record id>`): that record is
  dropped (`onRejected`) and the rest go again in one update. A refusal that names none,
  repeated more than three times in a minute, drops them all, so a copy never rebuilds forever.
- The records a rebuild carries live in the `ListCopy` (`carried`, `settleCarried`), stored
  durably by the browser's copy: the connection forgets them once the rebuilt copy holds them.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
