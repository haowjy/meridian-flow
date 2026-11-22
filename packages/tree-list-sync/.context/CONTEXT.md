# tree-list-sync

Design: `work/project-tree-design/design.md`, section 4 ("The admission check", "The browser",
"The list's room"). The server half it spoke to (`yjs-tree-room.ts`) is gone: the server's tree
room is on `/ws/loro` (`apps/server/server/lib/loro-tree-rooms.ts`), and this package goes when the
browser moves there. The page for the room is
`apps/server/server/domains/context/.context/tree-list-store.md`.

## Parts (`parts.ts`)

`splitUpdate` cuts an update of plain array items into parts that each apply once the parts
before them have, at most `maxItems` items each. Yjs merges consecutive pushes by one client into
one run, so a part cuts a run at a clock: a long offline session is one run of thousands of
records. A run waits for its neighbours (`origin`, `rightOrigin`) the way the admission requires
(nothing may sit beside an item the server lacks), so parts are in causal order across clients.
An update with a deletion, a type or anything but `ContentAny` comes back whole.

`splitSyncFrame` does the same for a Hocuspocus frame: all parts but the last are plain
updates, the last keeps the original's shape (a SyncStep2 stays one) so the receiver's own
bookkeeping happens once. Frames under 16 KB are not decoded.

## The handshake (`connect.ts`, `ListWebsocket`)

The provider sends each edit as an Update frame as soon as it can, and on a reconnect that is
before the client's SyncStep2, which carries what the server lacks: records of an earlier session
(a reloaded copy has a new client id) or an update lost in flight. Ahead of the SyncStep2 such an
edit sits beside a record the server does not hold, which the guard can't decide and faults
(`a neighbour the server lacks`, `not the next clock`). So the socket holds every Update frame of a
connection until that connection's SyncStep2 has gone, then sends the held ones. They are already
inside the SyncStep2 (the guard skips what it holds) but each still gets its `SyncStatus`, so the
provider's count of unconfirmed updates reaches zero. With this, an honest client never meets the
guard's faults; the room tests "takes a reloaded copy's earlier session…" and "reconnects a client
whose admission failed" prove it.

## Recovery (`connect.ts`)

After a close with `4212` the copy's `replace({ kind: "recover", carried, listId })` keeps the
records the copy held, as the package reader reads them (`listRecords`: a value that is no record
is skipped by every replay and isn't carried), and gives an empty document under a new client id; once the server's state has
arrived (`onSynced`) the records the new copy lacks (by record id) are appended in one update,
then `settleCarried()`. A record `clientMayWrite` refuses is not appended: it is what a client of
another build wrote, and `onDropped` reports the lot. `recovering` stays set until the server
has taken the appended records (`onUnsyncedChanges` reaching 0), so a second `4212` in that
window is `broken` and nothing loops; a later fault is a new recovery. A sync with nothing to
append, and a `4213`, end the recovery too.

A close with `4213` names the list the room serves: `replace({ kind: "discard", listId })`, nothing carried, since the
old records name nodes of a list that is gone. The id also arrives as the room's first stateless
message for a copy that has none, and goes on the socket URL as `?list=`.
