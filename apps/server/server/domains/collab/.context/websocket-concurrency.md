# Collab — WebSocket concurrency boundary

`withDocument()` serializes coordinator callers only. It does not exclude writer
WebSocket mutations, and writer admission is journal-first. Any content apply after
an `await` rechecks durable authority synchronously before applying or broadcasting.
Concurrent-change reporting may degrade without affecting apply authority.

A live-room writer frame is judged in the room's memory, in `admitLiveWriterUpdate`: contained
(acknowledged, nothing stored), a reserved client id or server-owned root (the socket closes), a
gap (the frame starts past the room's clock for one of its clients: `1013`, and the reconnect's
handshake carries the prefix), or new, trimmed to what the room lacks. A new frame is stored by
`LiveWriterJournal.appendWriterUpdate` before Hocuspocus applies, broadcasts and acknowledges it,
in one short transaction: the head row's counter bump and one insert. The head row's lock is the
whole lock a keystroke takes; it keeps journal order equal to commit order. The head it returns is
compared with the room's generation before the insert (the insert stamps what the bump returned);
a room bound to an older generation stores nothing and is retired. Two sockets relaying one new
update can both pass the room's judgement and store it twice: Yjs ignores the copy, and the cost
is a redundant row.

A Live command takes the same lock: `lockDocumentMutation` takes the advisory key and then the
head row `FOR UPDATE`, before the command reads anything, so a keystroke cannot commit between a
command's read and its rows, below the command's own ids and outside its recorded cut. Typing
holds only the row; commands hold both, always the key first.

Access is decided when the socket opens and ends when the gateway closes it: a frame takes
no edit grant and locks no Work. Document sockets register under their Work and lineage owners,
their project and their document (`accessKeys` in `yjs-ws-handler.ts`), so an archive, a project's
deletion or a document's move to another source closes them (`4409`).
