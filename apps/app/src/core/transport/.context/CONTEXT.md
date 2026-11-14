# Client transport seams

## Outbox and acknowledgement edges

The outbox is the session layer's evidence that the writer has typing the server
hasn't acknowledged.

- **Store, then send.** Yjs runs update listeners in registration order, so local
  bytes are stored before the provider's own listener sends them. The provider
  constructor doesn't mutate the document, and the explicit websocket keeps it from
  attaching on its own, so the early registration sees no constructor updates.
- **Edges only.** An acknowledgement clears the outbox before notifying.
  `DocumentSession.recomputeStatus` deduplicates on status, server acknowledgement and
  outbox presence, so a typing burst yields one pending snapshot and one clearing
  snapshot.

`whenCurrentChangesAcknowledged()` captures the socket's current FIFO prefix. An Apply
waits for that prefix, including update delete sets, not later keys. A reconnect moves
unresolved barriers to the next handshake upload, which contains every pre-click local
change. Terminal teardown rejects current and future barriers; ordinary disconnects
leave them pending. `4205` is terminal `closed`, not rebuild. In-band closes carry code
1000, so consumers use disposition rather than numeric code.

## Draft rooms

No timeout releases held frames: a server that never sends SyncStep1 leaves them held
and the room unacknowledged. After handshake-first, `4207` means a server that lost
committed rows or a peer that skips the handshake, and the next SyncStep2 repairs it.

## Access scope and 4409

`DocumentSession` carries the server-named scope as `snapshot.access`: `null` until the
server names one, then the last named scope, kept across drops and transport restarts.
An unnamed room is writable (local-first). Access isn't a connection state: a read-only
room that drops offline stays read-only.

`null` is what lets a named `edit` count. The Editor host's `readOnly` comes from its
Works catalog, which can predate the room's first connect. The host's
`RoomScopeCatalogCheck` (`features/project/context/ContextDocumentHost.tsx`) refreshes
that catalog when a named scope disagrees with `readOnly`. Its own changes to
`readOnly` don't ask, so the tab that archives fetches nothing extra.

A 4409 close that lands while local updates are unacknowledged resets with reason
`access-changed`, and `DocumentSession.refusedLocalEdits()` forbids `restartTransport`
for that session. A draft room rebuilds through `rebuildDraftRoom`. A live room goes
through the registry's `dropRefusedRoom`, which revokes each lease's access and clears
the IndexedDB copy still holding the refused edits. Editor hosts unbind at once
(`useRefusedEditsReopen`) and reopen when the drop settles; a drop that fails leaves the
refused session bound read-only rather than reopening again.

A 4409 on a connection already admitted read-only refuses nothing: the server dropped that
connection's updates unread, so the edits are held, not refused. The transport reconnects and
the new admission decides. An Unarchive admits it `edit` and the handshake delivers them; a
read admission holds them again.

## 4208: the document was removed

Terminal for live and draft rooms alike: nothing rebuilds, replays or drops the room,
and a draft review keeps the terminal session painted. Only a lookup after the close
that proves the document present restarts the room, once per close. See
`features/project/context/.context/resource-catalog-and-editor-lifecycle.md`.

## Stateless document messages

Live `DocumentSession`s subscribe to `change_event`; draft sessions don't.

## Dev-only wire observation

Runtime overlay enablement controls visibility, not capture. Separate `YjsWireTap` and
`ThreadWireTap` interfaces keep thread strings from broadening the Yjs byte contract.
The debug feature registers both in one authenticated-route composition action, before
either socket can be created. `notifyYjsRoomAttached` supplies the local
`Y.Doc.clientID` needed to attribute outgoing deletion-only updates, whose bytes contain
the deleted items' creators but not the deleter.

Provider hooks aren't the final-byte seam; use `TappedWebSocket`. Protocol inspection
and `EventRecord` construction belong in the debug feature, preserving the dependency
direction `features/debug -> core/transport`. Thread inspection emits only allowlisted
classifications and identifiers: no agent, user, tool, catchup or error content enters
an `EventRecord`.

Thread protocol, cursor and deadline contracts belong to the
[shared thread client](../../../../../../packages/thread-client/.context/CONTEXT.md).
App `onGap` consumers refetch snapshots, and a gap burst coalesces into one resync.

## Shared connectivity hints

Retry hints restart aggressive backoff, so repeated wakes against a down server cost at
most one attempt per cooldown. Success reports are transition-based and exclude the
successful source. `disconnect()` disables reconnection, while offline takes the normal
close path without awaiting a native handshake.

The room adapter's `onOpen` and `onClose` overrides work around two Hocuspocus 4.3 retry
races: native open clears the cancellation handle before the first frame settles the
attempt, and post-settlement close schedules a delayed reconnect that can replace a
still-CONNECTING hinted socket.

These listeners stay outside the shared hints: the resource replica's 30-second interval
for pending HTTP work, working-set pagehide and hidden-visibility flushes (persistence
signals), and local document peers and session wakeup (content recovery, independent of
network jitter).
