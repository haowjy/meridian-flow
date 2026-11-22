# Client transport seams

## The document room on `loro-protocol`

One socket per room, at `LORO_WS_PATH`. The room name is `loroRoomName(room)`; presence uses
the same name with the ephemeral-store CRDT tag.

The Join exchange, which the server's handler speaks too (local-first design §4):

1. The client sends `JoinRequest` with its room version (`encodeRoomVersion`, one version
   vector per doc key) and `encodeLoroJoinAuth({schema, peer})`.
2. The server answers `JoinResponseOk` with the permission and its own room version, then
   sends what the copy lacks as one `DocUpdate` (fragmented when large).
3. The client joins presence, sends its presence state, and sends
   `copy.exportSince(serverVersion)` as one `DocUpdate`.

The server does not relay presence yet: it drops every ephemeral-store frame, so a remote caret
shows only once the relay lands.

A room without presence (a tree list) passes no store and joins no presence channel. `onJoined`
sees each `JoinResponseOk`'s `extra` before anything is sent and may ask to rejoin: a tree copy of
another list is replaced under the Join, so the Join's version must be taken again.

Every client `DocUpdate` is acknowledged by one `Ack` naming its batch id; server
`DocUpdate`s are not. The transport keeps, per unacknowledged batch, the room version the
batch ends at (read from the update metadata), and merges it into the server version on its
`Ack`. A dropped socket forgets unacknowledged batches: the next Join's `exportSince`
covers them.

## Acknowledgement and barriers

`subscribeServerAcknowledgement` is true while the room is connected, joined, and every batch
sent on this connection is acknowledged. `whenCurrentChangesAcknowledged()` captures the
copy's version at the call and resolves once the server version covers it, whether through
acks or through batches the server sent. Terminal ends reject current and future barriers;
ordinary disconnects leave them pending.

## Errors

- `JoinError` with `document-deleted`, `client-schema-superseded` or `document-schema-stale`
  resets the room (`resetState`); `bad-auth` and `permission-denied` end it `unauthorized`;
  any other app code (the server hasn't seen this browser's `create` yet) closes and rejoins.
- `RoomError` `document-deleted` resets the room. `RejoinSuggested` is an access change: the
  room shows read-only at once (`access-changed:<why>` names the cause), the socket rejoins,
  and the new `JoinResponseOk` permission decides. A read permission sends no `DocUpdate`.
- Close codes `AUTH_FAILED` and `PERMISSION_DENIED` end the room `unauthorized`; any other
  close retries with backoff (`RETRY_MS`), at once for a `rejoin` close.

## Access scope

`DocumentSession` carries the server-named scope as `snapshot.access`: `null` until the
server names one, then the last named scope, kept across drops and transport restarts.
An unnamed room is writable (local-first). Access isn't a connection state: a read-only
room that drops offline stays read-only.

`null` is what lets a named `edit` count. The Editor host's `readOnly` comes from its
Works catalog, which can predate the room's first connect. The host's
`RoomScopeCatalogCheck` (`features/project/context/ContextDocumentHost.tsx`) refreshes
that catalog when a named scope disagrees with `readOnly`.

## Stateless document messages

Every `DocumentSession` subscribes to `change_event`.

## Dev-only wire observation

Only the thread socket is tapped (`ThreadWireTap`). The Loro room socket has no tap yet: the
old Yjs inspector read Yjs frames, and its Loro replacement is left for 1e.

Thread protocol, cursor and deadline contracts belong to the
[shared thread client](../../../../../../packages/thread-client/.context/CONTEXT.md).
App `onGap` consumers refetch snapshots, and a gap burst coalesces into one resync.

## Shared connectivity hints

Retry hints restart aggressive backoff, so repeated wakes against a down server cost at
most one attempt per cooldown. A `suspect-offline` hint closes the room socket through the
normal close path; `retry-now` connects at once when no socket is open.
