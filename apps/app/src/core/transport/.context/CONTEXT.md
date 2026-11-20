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
leave them pending. In-band closes carry code
1000, so consumers use disposition rather than numeric code.

## Frames the server can't store

A frame the server could not store closes `1013` (`WS_CLOSE.WRITER_ADMISSION_FAILED`), and the reconnect's handshake resends it; a frame that starts past the
room's clock closes the same way, and the handshake repairs the gap. Three such closes in a row
with no acknowledgement between end the room `UPDATES_REFUSED`, whether or not the outbox holds
anything (typing replayed from the copy goes out in each handshake without passing through it), because a frame
the server can never store (a replay of a retired generation, refused in `live-room.ts`) would
otherwise resend forever. The session then holds undeliverable edits, and the registry replaces the room as it
does a read admission's (editor context, "Undeliverable edits"): the typing is dropped with one
"Couldn't save" pill and the editor shows the server's text. Any `1013` counts, whatever its
reason.

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

A 4409 `access-changed` close never resets the room, whatever is unacknowledged. It marks
the room read-only at once, the transport reconnects, and the new admission decides: a
read admission (an archived Work's view, a trashed chat's) sends no Update frame (the socket
drops them; the server would answer each `false`), and each of its handshakes says what the
document holds that the server lacks: the server's SyncStep1 and SyncStep2 pair, read by
`handshake-difference.ts` (the document equals the server when the server's snapshot, state
vector and delete set, contains `encodeStateAsUpdate(document, serverStateVector)`). The session
decides what that means (`DocumentSession`, "Undeliverable edits" in the editor context): a room
holding the writer's edits is replaced by one loaded from the server and the typing is handed
back, so an Unarchive delivers nothing late. A local change the session does not count (not a
display write) asks for one `forceSync`, whose handshake decides. Acknowledgement on a read
admission is that verdict, not `SyncStatus`. An edit admission (an Unarchive) delivers what the
room holds in the handshake. A room no editor holds is retired at the read-only mark, before the
reconnect: its edits stay in the IndexedDB copy and are delivered the next time the
document opens (an open while the Work is still closed hands them back). Writer text is never
dropped for an access change. The
server sends 4409 only when the scope it admitted no longer holds (an archive, an
Unarchive, a lifecycle change under a Work's write), so the reconnect's admission matches
what the write path accepts. A close because a Work or chat closed carries the cause,
`access-changed:work_archived`, `work_deleted` or `chat_frozen`: read it with `accessChangedWhy(event)`
and recognize any 4409 with `isAccessChangedClose(event)` (both in `ws-close.ts`); the transport's
`handleClose` is the one place the editor reads 4409.

## 4208: the document was removed

Terminal: nothing rebuilds, replays or drops the room, and a review keeps the terminal
session painted. Only a lookup after the close
that proves the document present restarts the room, once per close. See
`features/project/context/.context/presented-documents-and-editor-lifecycle.md`.

## Stateless document messages

Every `DocumentSession` subscribes to `change_event`.

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

These listeners stay outside the shared hints: local document peers and session wakeup (content recovery, independent of
network jitter).
