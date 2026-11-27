# Client transport seams

## The document room on `loro-protocol`

One socket per room, at `LORO_WS_PATH`. The room name is `loroRoomName(room)`; presence uses
the same name with the ephemeral-store CRDT tag.

The Join exchange, which the server's handler speaks too (local-first design §4):

1. The client sends `JoinRequest` with its room version (`encodeRoomVersion`, one version
   vector per doc key) and `encodeLoroJoinAuth({schema, peer, account})`. `account` is the
   account the tab's lifetime belongs to; the socket authenticates with the browser's cookie,
   which may have changed account since.
2. The server answers `JoinResponseOk` with the permission and its own room version, then
   sends what the copy lacks as one `DocUpdate` (fragmented when large).
3. The client joins presence, sends its presence state, and sends
   `copy.exportSince(serverVersion)` as one `DocUpdate`.

`whenSynced` resolves once the transport has handed the copy the first Join's version (the copy's
version at the Join merged with each batch received since), not at `JoinResponseOk`: an editor
bound at the answer alone showed a large chapter as an empty page until its text arrived. It is
decided from what was handed, not from `copy.version()`: the composition guard may hold a batch
and import it later without the transport seeing it, which left the room never synced. Tree lists
read the same `synced`.

The server relays presence (`apps/server/server/lib/loro-presence.ts`): a presence Join is answered
with the presence the room holds, each update goes to the room's other sockets unacked, and a
socket that leaves has its entries deleted for the others at once.

A room without presence (a tree list) passes no store and joins no presence channel. `onJoined`
sees each `JoinResponseOk`'s `extra` before anything is sent and may ask to rejoin: a tree copy of
another list is replaced under the Join, so the Join's version must be taken again.

Every client `DocUpdate` is acknowledged by one `Ack` naming its batch id; server
`DocUpdate`s are not. The transport keeps, per unacknowledged batch, the room version the
batch ends at (read from the update metadata), and merges it into the server version on an
`Ack` whose status is `Ok`. A refused batch (`PermissionDenied`, sent when the connection lacks
write access) stays unacknowledged until the socket drops: the stored server mark decides what
sign-out waits for, so a refusal recorded as delivered would lose the batch. `sendLacking` sends
what the copy holds beyond the server version and the batches in flight; the Join uses it, and so
does a session holding another tab's typing that tab never sent. A dropped socket forgets unacknowledged batches: the next Join sends what the version the
server answers with lacks, so a batch the server imported before its `Ack` was lost is not sent
again.

## Acknowledgement

`subscribeServerAcknowledgement` is true while the room is connected, joined, and every batch
sent on this connection is acknowledged.

`whenSentAcknowledged()` is what a press waits on before it leaves (design §4): it resolves once
every batch sent so far is acknowledged. A room that is not connected (offline, reconnecting, signed
out) is waited for until it is connected again and the Join's own batch, which carries everything typed
while away, is acknowledged; a socket that drops mid-wait moves the wait to the next Join. A
waiter takes the batch ids it waits on only once the room reads as connected, which comes after
the Join's batch is sent, so nothing emitted between the Join's answer and that batch can let it
through early. It resolves when the room ends or is destroyed. Resolving at once on a room that
was not joined let a press made offline reach the server before the offline typing did, so it
pressed an older fork. A sign-in lapse used to end the room the same way: with the writer signed
in again in another tab, the press went out over HTTP while the typing stayed in this tab's copy.

The transport covers only a room that has one. The rest of the rule is above it:
`DocumentSession.whenSentAcknowledged` waits while its copy is still loading and its transport is
not attached yet, and the registry's `whenSentAcknowledged` names the press's rooms (the forks of
its drafts, of its documents when it names them, and their Live rooms) and opens and retains the
ones whose copy here holds ops beyond its server mark (`storedOpsBeyondMark`) but that the tab
has no session for, which is how a reload or another tab's typing is covered. Not covered: in a
press of a whole draft or Work, the Live room of a document only the draft holds, which no fork names.

## Errors

- `JoinError` with `document-deleted`, `client-schema-superseded` or `document-schema-stale`
  resets the room (`resetState`); `permission-denied` ends it `unauthorized`, `bad-auth` (a
  Join this build formed wrong) ends it `terminal`, and `account-changed` (the cookie is another
  account's) ends it `terminal` and calls `onAccountChanged`, which ends the account's lifetime.
  `loro-protocol` carries `appCode` only on an `AppError`, so an `AuthFailed` refusal
  (`permission-denied`, `bad-auth`, `account-changed`) is read from `message`;
  any other app code (`document-unknown`: the server hasn't seen this browser's `create` yet, a
  document's or a new project's for its list, or
  the draft is gone for good) closes and rejoins with backoff.
- `RoomError` `document-deleted` resets the room. `RejoinSuggested` rejoins: for an access
  change (`access-changed:<why>` names the cause) the room shows read-only at once and the new
  `JoinResponseOk` permission decides; for a server error the rejoin sends what the server lacks.
  Any other `RoomError` ends the room `terminal`. A read permission sends no `DocUpdate`.
- Close code `PERMISSION_DENIED` ends the room `unauthorized`. `AUTH_FAILED` makes it
  `signed-out`, which retries like any other close: with backoff (`RETRY_MS`), at once for a
  `rejoin` close or a retry-now hint. It stays `signed-out` across the retries' other closes until
  a Join is answered.

## Access scope

`DocumentSession` carries the server-named scope as `snapshot.access`: `null` until the
server names one, then the last named scope, kept across drops and transport restarts.
An unnamed room is writable (local-first). Access isn't a connection state: a read-only
room that drops offline stays read-only.

`null` is what lets a named `edit` count. The Editor host's `readOnly` comes from its
Works catalog, which can predate the room's first connect. The host's
`RoomScopeCatalogCheck` (`features/project/context/ContextDocumentHost.tsx`) refreshes
that catalog when a named scope disagrees with `readOnly`.

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
