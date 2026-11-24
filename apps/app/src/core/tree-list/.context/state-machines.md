# Tree list state machines

## List connection

A tab's view of one list's connection (`TreeListStatus` in `tree-list-session.ts`, mapped from the
room transport's state). Every tab joins the list's room on `/ws/loro` itself. It has the shape of
[a connection that replays](../../../../../../.context/state-machines/connection-that-replays.md)
with the Join exchange in place of a replay: each Join sends what the server lacks and receives
what the copy lacks, so reconnecting brings the copy and the server level.

```mermaid
stateDiagram-v2
  [*] --> waiting: the session opens
  waiting --> synced: the Join's catch-up is handed to the copy
  synced --> offline: the socket closes
  offline --> synced: it rejoins
  synced --> waiting: the Join names another list: a fresh copy, joined from nothing
  waiting --> denied: a permission-denied Join error, or close 4403
  waiting --> unauthenticated: close 4401
  synced --> unauthenticated: close 4401
  offline --> unauthenticated: close 4401
  unauthenticated --> synced: it rejoins once the writer has signed in again
  waiting --> broken: a bad-auth Join error ends the room
  synced --> broken: the server ended the room (a corrupt update)
  offline --> broken: the same, on rejoining
  denied --> [*]
  broken --> [*]
```

- `waiting` lasts until the first Join of this session and its catch-up batch are in, however
  much the stored copy holds: a copy that has not caught up is not proof that a node is absent.
  The session reads the transport's `synced`; it keeps no rule of its own.
- `JoinResponseOk.extra` names the list (`LoroJoinExtra.list`). A stored copy of another list (a
  reset database, a recreated account list) is replaced by an empty one, which carries nothing:
  its records name nodes that are gone. The old copy's doc is freed when the session closes.
- `broken` keeps the copy and the writer's records on the device; nothing connects again.

