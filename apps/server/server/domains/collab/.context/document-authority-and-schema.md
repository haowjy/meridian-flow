# Collab — document authority and schema admission

This page says what holds a document's text and the one schema-aware path that reads and writes
it as Markdown.

## The Live room is the authority

A document's text is its Live room, `live:<documentId>`: a structure doc and a text doc per block,
stored as `document_snapshots` rows (one per doc, keyed `room_key`, `doc_key`) and loaded by
`DocumentRooms` (`rooms/postgres-document-rooms.ts`). There is no head, journal or checkpoint: a
loaded room is a cache of its rows, and a save writes the docs that changed. A doc whose row
already holds all of it is not saved again: rows a commit or seed just wrote, or a save's merge
just read, pass their versions to the import (`imported`'s `stored`). A room with no rows
reads as an empty document, so a document created without text needs no row and no repair.

A command reads its copy of the room in its transaction (`DocumentRooms.read` merges the stored
rows with what the loaded room holds) under the document's advisory lock
(`shared/document-mutation-lock.ts`), so what it plans on is what it holds the lock for.

## First text

`domain/markdown-document.ts` writes a document's first text two ways:

- `seedFromMarkdown` takes a fresh `BoundWrite` and, under the document's lock, writes it only
  when the room holds no state; otherwise it does nothing. Creates, bootstrap and seeds use it.
- A bulk create (Copy, an import) encodes each document's first state with `encodeSeed` before
  its transaction and installs them inside it with `installSeeds`. It takes no lock, because
  nothing else can reach those ids yet, and derives nothing: the caller refreshes projections
  after commit.

## Removal

A deleted document keeps its rows for Restore; only the purge deletes them
(`release-document-content.ts`). A removal answers a model as a `DocumentNotFoundError` carrying
the removal record, so every not-found mapping, a model's read included, answers a removal as
`document_not_found` with who removed it (agent-edit's `removedFile` in `removal-copy.ts`). A
model's text edit, undo or revert the removal stopped is not refused: it is a `done` row that says
`returned` with `document_removed` and the record in `returned.removal` (agent-edit's
`returnedWriteResult`), which the chat's card words. It is answered from an identity the call
already holds (the document the write resolved to, or the node the model was shown); a write by a
path that no longer resolves stays `document_not_found`.

## Schema-aware document engine

`domain/markdown-document.ts` is the server's one Markdown door to a document's text: every read,
whole-document write, seed and code merge outside the model's own tools goes through it, reading a
copy of the room and committing what changed as one batch. It resolves the persisted filetype
before parse or serialization. Markdown uses the document codec; code uses the constrained code
representation and returns raw text without fences. A missing or unregistered filetype uses the
document schema; a registered binary filetype on a tracked document returns `corrupt_state`.

All whole-document writes enter as a `BoundWrite`, not an unscoped Markdown string. The link
binder parses, prepares the holder's link scope, assigns or preserves refs, registers ahead refs,
and certifies the target before the caller opens a transaction. A fresh bind is initialize-only:
a non-empty target is `stale_document`. Context checks the canonical path under the project's list
key and returns `stale_target` when its occupant changed.

`agent-edit-runtime.ts` builds the codec once. Every serialization door gets a holder-bound
`DocumentLinkScopes` snapshot and prepares the refs it will spell before synchronous
serialization. Scope snapshots are operation-local and never cached across reads, accounts,
threads, or moves. Parse is pure syntax; agent-edit assigns refs after parsing.

A whole-document write aligns assigned nodes against the room's copy (`overwriteWithAssigned`),
so unchanged blocks keep their ids and a concurrent writer's typing merges as a peer's. Do not
replace the room's blocks wholesale: that loses ids and reattributes kept prose.

## Schema admission

A room's Join carries the client's schema version (`lib/loro-ws-handler.ts`). The handler compares
it with the document's `documents.schema_version`: a document stored under a major this server
does not serve is refused `document-schema-stale`, and a client behind the document is refused
`client-schema-superseded`. Patch differences do not gate. Each save stamps the room's document
with `greatest(stored, server)`, so a rolled-back server never lowers it.

## Downlinks

- [ContextFS contracts](../../context/.context/CONTEXT.md)
- [Collab shared contracts](CONTEXT.md)
- [WebSocket concurrency](websocket-concurrency.md)
