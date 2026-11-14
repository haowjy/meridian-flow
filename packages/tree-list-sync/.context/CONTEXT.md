# tree-list-sync

Design: `work/project-tree-design/design.md`, section 4 ("The admission check", "The browser",
"The list's room"). The server half is `apps/server/server/lib/yjs-tree-room.ts`; the page for
its protocol is `apps/server/server/domains/context/.context/tree-list-store.md`.

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

## Recovery (`connect.ts`)

After a close with `4212` the copy's `replace(carried, listId)` keeps the records the copy held
(`carried()`) and gives an empty document under a new client id; once the server's state has
arrived (`onSynced`) the records the new copy lacks (by record id) are appended in one update,
then `settleCarried()`. A record `clientMayWrite` refuses is not appended: it is what a client of
another build wrote, and `onDropped` reports the lot. `recovering` stays set until the server
has taken the appended records (`onUnsyncedChanges` reaching 0), so a second `4212` in that
window is `broken` and nothing loops; a later fault is a new recovery.

A close with `4213` names the list the room serves: `replace([], id)`, nothing carried, since the
old records name nodes of a list that is gone. The id also arrives as the room's first stateless
message for a copy that has none, and goes on the socket URL as `?list=`.
