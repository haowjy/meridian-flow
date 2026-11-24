# Collab — WebSocket concurrency boundary

A tab's batch is imported into the loaded room as sent (`DocumentRooms.write`), relayed to the
room's other sockets and acknowledged at once; nothing is judged or refused for what it says. The
room saves the docs it changed within seconds (`debounceMs` 2 s after the last batch, at most
`maxDebounceMs` 10 s after the first unsaved one). A batch acked but not yet saved is lost if the
server stops; the tab still holds it, and its next Join sends what the room's version lacks.
Two sockets relaying one update import it twice; Loro ignores the copy.

A command takes the document's advisory lock (`lockDocumentMutation`) and reads its copy of the
room inside its transaction, merged from the stored rows and the loaded room
(`DocumentRooms.read`, `commit`). It writes the rows of the docs it changed and hands its batch to
the loaded room only after commit, so a rollback never reaches an open editor. A tab's batch
takes no lock; the room's save of it takes the document's lock, so a save never lands between a
command's read and its commit.

Access is decided at the Join and ends when the gateway ends the room: a batch takes no edit
grant and locks no Work. Document rooms register under their Work and lineage owners, their
project and their document (`accessKeys` in `lib/loro-ws-handler.ts`), so an archive, a project's
deletion, a document's move to another source, or its coming into Live from a Work's draft (an
applied create, whose room was admitted as the Work's) ends them (`RoomError` `access-changed`),
and the client joins again at the new access (`writeLive` in `context/adapters/tree-list-rows.ts`
names both).
