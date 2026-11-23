# Port contracts

Each port's shape and method comments are in `src/ports/`. These are what a host
must do that the types can't say.

## `AgentEditRooms`

`save(room, batch, record)` runs inside the host's command: `commit` the batch, then
`recordWrite` the record and the batch in the same transaction, so a write and its Undo record
land or fail together. The record's `delta` is the write's before and after text by block; turn
Undo and the model's `undo` and `revert` take it back by content (`takeBack`) in the record's
`room`, never by replaying ops, so the writer's later edits stay. Its `before` is each written doc's
version as the write began: a Draft turn's `Restore before` starts from its first write's.
`readRoom` returns a copy the core frees; it holds none between calls.

`roomFor` is the one place that picks a chat's room: a Draft chat's fork room from its first read,
with no "does the fork exist" lookup (a fork with nothing stored reads as Live), and Live for a
Live chat or a document only the draft holds. The host's `planning` and `recording` lookups answer
per room name; the core asks under the fork's name and its Live room's, and takes the later read
(`recordedRead`).

## `AgentEditCodec`

A command takes one scoped codec
at entry and passes it to every serialization door; the package has no default
Meridian schema. The host's `codecFor(documentId)` picks the codec per document: a code
document's is `verbatimCodec` (`@meridian/markup`), whose text is one code block and never
Markdown, for reads, parses and echoes alike.

## `DocumentLinksPort`

Save-time replicas are disposable and are released even when link preparation
fails. An unprepared ref, settlement or address is a snapshot miss, never an
invented location.

## `AgentEditModel`

The resolver projects once, first (`projectBlocks`); its scopes, hashes and anchors index that
list, and a whole-document write takes its scope from it, never from a count taken earlier.

`key` names the block in this document: its block id. `hash` and `fullHash` come from the same id
(`fullHashForBlockId`); hash lookup matches `fullHash`.

## `AgentEditCore`

`responseIdentity` separates provider authorship from the rotated edit scope.

## Performance

Multi-block callers project once and serialize from that projection; per-block
helpers rescan the document and can be quadratic.
