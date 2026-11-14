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

## Rebuild (`connect.ts`)

After a close with `4210` the copy's `replace()` keeps the records the copy held (`carried()`) and
gives an empty document under a new client id, and once the server's state has arrived
(`onSynced`) the records the new copy lacks (by record id) are appended again, then
`settleCarried()`. The first rebuild appends them in one update (an honest client's rebuild is one
admission, never a stream that meets the rate limit). When the server's refusal names a
record (the close reason is `list-rebuild:<record id>`; `admit` returns the record in its whole
refusal), that record is given up on (`onRejected`) and the rest go again in one update, so one
hostile record cannot starve the honest ones behind it. A refusal about the update's own
structure names none: after more than three rebuilds within a minute all the carried records are
given up on, so the copy cannot rebuild forever.
