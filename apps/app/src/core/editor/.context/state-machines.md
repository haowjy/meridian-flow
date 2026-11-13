# Editor session state machines

## Document session status

What one open document's connection to the server is doing (`DocumentSessionStatus` in
`document-session.ts`). Apart from `destroyed`, the status is not stored and stepped: it is
recomputed by `deriveStatus` from the facts below whenever one of them changes. Draw it as a
machine to see what the writer can observe; change it by changing the derivation.

```mermaid
stateDiagram-v2
  [*] --> detached: session created, no transport
  detached --> syncing: transport attached
  syncing --> synced: connected and the server has synced
  synced --> syncing: reconnecting, degraded, or connecting again
  synced --> offline: disconnected
  syncing --> offline: disconnected, or a terminal close
  offline --> syncing: the transport reconnects
  syncing --> access_lost: unauthorized, or a reset
  synced --> access_lost: unauthorized, or a reset
  offline --> access_lost: unauthorized, or a reset
  state "access-lost" as access_lost
  detached --> destroyed: destroy
  syncing --> destroyed: destroy
  synced --> destroyed: destroy
  offline --> destroyed: destroy
  access_lost --> destroyed: destroy
  destroyed --> [*]
```

`deriveStatus` decides in this order:

1. No transport: `syncing` while one is being attached, else `detached`.
2. Local persistence not yet replayed: `syncing`.
3. Transport `unauthorized` or `reset`: `access-lost`. Transport `terminal`: `offline`.
4. First server sync not complete: `syncing`.
5. Transport `disconnected`: `offline`.
6. Transport `reconnecting`, `degraded` or `connecting`, or the provider not synced: `syncing`.
7. Otherwise `synced`.

- **The terminal checks come before the first-sync gate** (step 3 before 4). After a permanent
  denial the first sync never completes, and with the order reversed the document would show
  "syncing" forever.
- **`reconnecting` is `syncing`, not `offline`.** `offline` means edits are only being kept
  locally; the pill the writer sees is built on that difference
  ([sync status](../../../features/editor/.context/state-machines.md)).
- **`synced` does not mean the server has every local edit.** The snapshot's
  `serverHasLocalChanges` says that: it is true once the server has acknowledged every local
  update sent on this connection, and false again on the next local edit or a disconnect.
- `destroyed` is the one stored state: once set, `recomputeStatus` returns without deriving.
- The transport states are `ConnectionState` from
  [thread-client](../../../../../../packages/thread-client/.context/state-machines.md); the
  document transport is the publisher of `reset` and `unauthorized`.

## Draft room read

Whether a draft's room can be shown and acted on (`DraftRoomState` in `draft-room-read.ts`).
A draft is a pending version of one document, and its room is the Yjs room `draft:<draftId>`
that the review screens open instead of the live document's.

```mermaid
stateDiagram-v2
  [*] --> rebuilding
  rebuilding --> usable: the room is rebuilt and bound
  rebuilding --> error: the rebuild threw
  usable --> fenced: this tab's document schema no longer fits the room
  usable --> rebuilding: reset because the room was refused
  usable --> unavailable: the room is gone, terminal, unauthorized or destroyed
  fenced --> usable: the session reports usable again
  error --> rebuilding: retry
  unavailable --> rebuilding: retry
```

- **Commands act only on `usable`** (`usable()`). A `fenced` room is one whose document schema
  this tab's code no longer matches: the editor may still show it, with a notice, but a
  command on it would write with a schema the server has refused.
- **A refused room is rebuilt once per session.** The pool retires the session in the same
  notification, and the `refused` latch stops later snapshots from the retired session from
  starting a second rebuild.
- **Retry from `unavailable` works only when the room can be opened again.** A room the pool
  closed for good stays unavailable.
- A rebuild result is used only if it is still the newest attempt and the read is not disposed.
