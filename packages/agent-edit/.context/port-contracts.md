# Port contracts

Each port's shape and method comments are in `src/ports/`. These are what a host
must do that the types can't say.

## `AgentEditRooms`

`save(room, batch, record)` runs inside the host's command: `commit` the batch, then
`recordWrite` the record and the batch in the same transaction, so a write and its Undo record
land or fail together. The record's `delta` is the write's before and after text by block, which
the card and the edits list show; its `edit` is what turn Undo and the model's `undo` and `revert`
take back, whole or not at all, by design §2's Undo rule (`undoInRooms`) in the record's `room`, so
the writer's later edits stay; a Draft turn's restore press takes the turn's edits back the same
way, newest first. The record is self-describing; the batch is for storage, not to be decoded again.
`readRoom` returns a copy the core frees; it holds none between calls.

`roomFor` is the one place that picks a chat's room: a Draft chat's fork room from its first read,
with no "does the fork exist" lookup (a fork with nothing stored reads as Live), and Live for a
Live chat or a document only the draft holds.

## `FrontierLookups`

`planning` and `recording` take a document id and answer the chat's latest recorded read of that
document in any of its rooms (Live or any draft's fork), as recorded, with the room it read
(`ObservationFrontier.room`). "Latest" is the order the reads were recorded in, across rooms: a chat
switches between Live and Draft, and the core decides whether the room it writes in can check that
read out. `planningShown` takes a document id and answers every block the planning blocks showed of
it in full, from every room, oldest first. On the server each is a per-document query over
`observation_frontiers`: its rooms are the document's Live room and its fork room in every
draft of the project (`drizzle-model-evidence.ts`).

## `AgentEditCodec`

A command takes one scoped codec
at entry and passes it to every serialization door; the package has no default
Meridian schema. The host's `codecFor(documentId)` picks the codec per document: a code
document's is `verbatimCodec` (`@meridian/markup`), whose text is one code block and never
Markdown, for reads, parses and echoes alike.

## `DocumentLinksPort`

A `prepare` that is never called leaves the operation's scope without the row: an unprepared ref or
address is a snapshot miss (`undefined`), never an invented location.

## `AgentEditModel`

`key` names the block in this document: its block id. `hash` and `fullHash` come from the same id
(`fullHashForBlockId`); hash lookup matches `fullHash`.

## `AgentEditCore`

`responseIdentity` names the response a write is authored in (the host's `ResponseAuthorship`),
separate from the writing session.

## Performance

Multi-block callers project once and serialize from that projection; per-block
helpers rescan the document and can be quadratic.
