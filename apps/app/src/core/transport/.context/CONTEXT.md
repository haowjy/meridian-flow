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

The server relays presence (`apps/server/server/lib/loro-presence.ts`): a presence Join is answered
with the presence the room holds, each update goes to the room's other sockets unacked, and a
socket that leaves has its entries deleted for the others at once.

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

`whenSentAcknowledged()` is what a press waits on before it leaves (design §4): it resolves once
every batch sent so far is acknowledged. A room that is not connected (offline, reconnecting) is
waited for until it is connected again and the Join's own batch, which carries everything typed
while away, is acknowledged; a socket that drops mid-wait moves the wait to the next Join. A
waiter takes the batch ids it waits on only once the room reads as connected, which comes after
the Join's batch is sent, so nothing emitted between the Join's answer and that batch can let it
through early. It resolves when the room ends or is destroyed. Resolving at once on a room that
was not joined let a press made offline reach the server before the offline typing did, so it
pressed an older fork.

The transport covers only a room that has one. The rest of the rule is above it:
`DocumentSession.whenSentAcknowledged` waits while its copy is still loading and its transport is
not attached yet, and the registry's `whenSentAcknowledged` names the press's rooms (the forks of
its drafts, of its documents when it names them, and their Live rooms) and opens and retains the
ones whose copy here holds unsent words but that the tab has no session for, which is how a reload
or another tab's typing is covered. Not covered: an unsent deletion or format change with no
words in it in a copy the tab has not opened, and, in a press of a whole draft or Work, the Live
room of a document only the draft holds, which no fork names.

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

Both sockets are tapped in dev: the thread socket (`ThreadWireTap`) and the Loro room socket
(`LoroWireTap` in `wire-tap.ts`, fed by `loro-room-transport.ts`: every message it sends or
decodes, and each socket open and close). The debug overlay maps them to `wire.thread` and
`wire.loro` records (`features/debug/trace/`), metadata only: a frame's class, bytes, batch id and
channel, never its updates.

Thread protocol, cursor and deadline contracts belong to the
[shared thread client](../../../../../../packages/thread-client/.context/CONTEXT.md).
App `onGap` consumers refetch snapshots, and a gap burst coalesces into one resync.

## Shared connectivity hints

Retry hints restart aggressive backoff, so repeated wakes against a down server cost at
most one attempt per cooldown. A `suspect-offline` hint closes the room socket through the
normal close path; `retry-now` connects at once when no socket is open.
