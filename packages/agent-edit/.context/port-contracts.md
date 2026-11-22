# Port contracts

Each port's shape and method comments are in `src/ports/`. These are what a host
must do that the types can't say.

## `AgentEditRooms`

`save(room, batch, record)` runs inside the host's command: `commit` the batch, then
`recordWrite` the record in the same transaction, so a write and its Undo record land or fail
together. The record's `delta` is the write's before and after text by block; turn Undo and
`revert` take it back by content (`takeBack`), never by replaying ops, so the writer's later edits
stay. `readRoom` returns a copy the core frees; it holds none between calls.

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
