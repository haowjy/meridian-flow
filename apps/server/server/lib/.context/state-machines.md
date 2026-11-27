# WebSocket handler state machines

Two per-connection machines held in process memory. Both exist so that a client never receives
or sends frames for a room it has not been admitted to.

## Thread subscription, server half

One thread subscription on one WebSocket peer (`ThreadSubscriptionLease.phase` in
`ws-thread-handler.ts`). The client half is the
[subscription in thread-client](../../../../../packages/thread-client/.context/state-machines.md).

```mermaid
stateDiagram-v2
  [*] --> pending: subscribe request passes authorization
  pending --> flushing: catch-up read and the subscribed frame sent
  flushing --> active: buffered events delivered
  active --> flushing: a live event arrives
  pending --> disposed: replay gap, read failure, newer request, unsubscribe, close
  flushing --> disposed: unsubscribe, replacement, close, send failure
  active --> disposed: unsubscribe, replacement, close, send failure
  disposed --> [*]
```

- **Events that arrive during catch-up are buffered**, then sent in sequence order above the
  last delivered sequence. Sending them as they arrive would put live events before the replay.
- **A newer request does not drop a working subscription early.** An `active` subscription stays until
  the new request is authorized; a `pending` one is replaced at once.
- `disposeLease` unsubscribes from the event hub and clears the buffer. A replay gap sends the
  client a `gap` frame; any other read failure is the one retryable subscribe error.

## A joined `/ws/loro` room

One room a socket has joined on `/ws/loro` (`loro-ws-handler.ts`; its state is the socket's
`Joined` entry): a document's `live:<doc>` or `fork:<draft>:<doc>`, or a tree list's
`tree:project:<id>` / `tree:account:<id>` (`loro-tree-rooms.ts`). One socket holds many rooms, and
a refusal or an end is a frame for that room, never a socket close.

```mermaid
stateDiagram-v2
  [*] --> joining: JoinRequest
  joining --> refused: JoinError (bad auth, permission, unknown or deleted document, schema)
  joining --> joined: JoinResponseOk, then the catch-up batch, then batches held while joining
  joined --> joined: DocUpdate imported (or admitted, for a tree) and acked; another copy's batch forwarded
  joined --> ended: RoomError (access changed, document deleted, corrupt bytes, history cutoff, server error)
  joined --> [*]: Leave, or the socket closes
  refused --> [*]
  ended --> [*]
```

- **Subscribe before sync.** The room is subscribed before the Join's catch-up is read, and what
  it hears in between is held and sent after the answer, so no batch falls between the catch-up
  and the stream.
- **A batch is never refused for what it says.** A document room's batch is imported into the
  room (`DocumentRooms.write`); a tree room's is admitted as sent (`TreeListStore.admit`) and its
  sockets, the sender's included, hear the stored list past what the room last sent, after each
  commit's `NOTIFY` (`tree_list_advanced`). Only bytes Loro cannot read (`corrupt-update`) and an
  update below a shallow cutoff (`history-cutoff`) end the room; a failure of the server's own is
  `server-error`, which the client rejoins on, and the Join resends what the room lacks.
- **Access is decided at Join and ends by access key.** A document room registers under its Work
  and lineage owners, its project and its document; a tree room under its own name, which is its
  project's access key. A change publishes under one of them and ends the room with
  `access-changed` (`access-changed:<why>` for a closed owner), and the client rejoins at the new
  access. A change between the first check and the registration is caught by asking again.
- **A tree room's answer names its list** (`JoinResponseOk.extra.list`): a client whose stored
  copy is of another list (a reset database, a recreated account list) drops it and joins again
  with no version.
- **A document socket that asked hears saves.** A Join whose auth says `saved: true` gets, straight
  after `JoinResponseOk`, a saved frame (`LORO_SAVED_CRDT`) stating every doc's saved version, and
  one after each save that moved one; saves heard while joining are sent after the held batches. The `Ack` means imported, not saved
  ([websocket concurrency](../../domains/collab/.context/websocket-concurrency.md)).
- **Frames over the protocol's cap come in fragments** (`docUpdateFrames`, `createFrameReader` in
  `@meridian/contracts/protocol`), joined back into one batch before it is handled.
