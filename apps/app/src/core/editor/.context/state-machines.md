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
- **`synced` does not mean the server has every local edit.** That is the snapshot's
  `serverHasLocalChanges`, true only when the transport has acknowledged them.
- `destroyed` is the one stored state: once set, `recomputeStatus` returns without deriving.
- The transport states are `ConnectionState` from
  [thread-client](../../../../../../packages/thread-client/.context/state-machines.md); the
  document transport is the publisher of `reset` and `unauthorized`.

## Draft room read

Whether a draft's room can be shown and acted on (`DraftRoomState` in `draft-room-read.ts`).

```mermaid
stateDiagram-v2
  [*] --> rebuilding
  rebuilding --> usable: the room is rebuilt and bound
  rebuilding --> error: the rebuild threw
  usable --> fenced: reset for a schema change
  usable --> rebuilding: reset because the room was refused
  usable --> unavailable: the room is gone, terminal, unauthorized or destroyed
  fenced --> usable: the session reports usable again
  error --> rebuilding: retry
  unavailable --> rebuilding: retry
```

- **Commands act only on `usable`** (`usable()`); the editor may still paint a `fenced`
  session, which carries the schema notice. Acting on a fenced room writes with a schema the
  server has refused.
- **A refused room is rebuilt once per session.** The pool retires the session in the same
  notification, and the `refused` latch stops later snapshots from the retired session from
  starting a second rebuild.
- A rebuild result is used only if it is still the newest attempt and the read is not disposed.
