# Collab — document authority and schema admission

This page defines the durable authority vocabulary and the one schema-aware
content path. Authority is the durable head and its identity/generation, not a
warm Y.Doc or an operation-specific mutation policy.

## Authority vocabulary

- The **document authority head** is the durable `document_yjs_heads` row and
  its fenced journal prefix.
- A **document mutation policy** admits fresh, certified, replicated, or
  generation-replacement content against a neutral `MutationTarget`.
- A **live document** is the mutable Y.Doc held by a loaded Hocuspocus room.

Every loaded handle, room, checkpoint, writer frame, Markdown replacement, and
agent journal batch carries the authority identity and generation that loaded
it. Persistence revalidates both under the document mutation lock and drops
stale bytes instead of relabeling them. Restore retires warm handles and
rooms; late load and connection completion revalidate before use.

## Only materialization makes a head (W52)

`adapters/drizzle-document-authority-head.ts` is the one writer of
`document_yjs_heads`: `initializeHead`, `allocateAdmission`, `advanceHead`
(with `checkpointId` when a checkpoint insert moves it), `retireThrough` and
`replaceGeneration`. Each write that moves a head joins the living `documents`
row in its own statement (`livingDocumentSql`, exported by context's
`tree/living-document.ts`), so a removal that won the document mutation lock
refuses it at no extra query. Purge in context's `node-rows.ts` deletes the
heads of documents already removed.

A head and its first checkpoint are written by one initialize-only primitive,
`InitialDocumentSeeds.seedInitialDocument`: under the document mutation lock it
proves the document is living (`requireLivingDocument`), writes nothing when any
checkpoint or update exists, and otherwise calls `initializeHead` and installs
the first checkpoint. Two kinds of caller reach it: the create's own
transaction (live create, a branch's new hidden row, bootstrap and seeds
through `seedFromMarkdown`, or `initializeEmptyDocument` for an empty create),
and explicit repair of a living document whose authority is absent
(`repairDocumentAuthority`, from its stored projection with links unbound).
Repair runs only on an explicit touch: the occupant `create-placement` returns,
a joined hidden candidate before its draft seeds, live overwrite and the held
live lease, and Hocuspocus room admission before its first generation read.
Everything else requires an existing head and creates nothing. Draft creation
(a Work draft or a thread peer) passes `requireLivingDocument` under the same
lock. A miss answers `DocumentNotFoundError`, carrying the removal record
(`removal`) when the document was removed.

`allocateAdmission` is the one live-write boundary (journal and settlement): a
removal that won the mutation lock refuses every later frame, staged save
install and Apply member there.

A deleted document keeps its head and history for Restore, so an existing head
is not a document that may change. Head reads say which they mean:
`findDocumentAuthorityHead` / `readDocumentAuthorityHead` (nullable / required)
read a retained head for history; with `{ living: true }`, read under the
mutation lock, they gate every other door that mutates retained history:
version replacement and an explicit checkpoint refuse with the record; a
background checkpoint store and compaction do nothing. `advanceHead`, which
every checkpoint insert passes, is the backstop. `readHeadRevision` is the live
text's revision the review list's fingerprints and the review action fence
compare. Journal-row edit links (`document_yjs_updates.edit_id`) are written
only beside the admission that inserted the row. Reads of a deleted document's
history stay open; only purge deletes it.

A removal refuses as a `DocumentNotFoundError` carrying the removal record, so
every not-found mapping, the model's included, answers a removal as
`document_not_found` with who removed it (status and words once, agent-edit's
`removedFile` in `removal-copy.ts`) until the model gets its own `document_deleted` answer. A
reply's write the removal stopped, refused when staged or at the save, is one
`invalid_write` with `rejected: "removed"` and the record in `removal`
(agent-edit's `removedWriteRefusal`), which the chat's card words. Its sentence
stands alone on both paths: the save path adds no "Write did not land." prefix.

## Schema-aware document engine

`domain/markdown-document.ts` is the sole read/write and Y.Doc projection
engine. It resolves persisted filetype before parse or serialization. Markdown
uses the document codec; code uses the constrained code representation and
returns raw text without fences. Checkpoint restore installs projected nodes
directly rather than serializing and reparsing a snapshot.

All whole-document writes enter as a `BoundWrite`, not an unscoped Markdown
string. The link binder parses, prepares the holder's link scope, assigns or
preserves refs, registers ahead refs, and certifies the target before the
caller opens a transaction. A fresh bind is initialize-only: admission refuses
a non-empty target with `stale_generation`. Context checks the canonical path
under namespace lock and returns `stale_target` when its occupant changed.

`agent-edit-runtime.ts` builds the codec once. Every serialization door gets a
holder-bound `DocumentLinkScopes` snapshot and prepares the refs it will spell
before synchronous serialization. Scope snapshots are operation-local and
never cached across reads, accounts, threads, or moves. Parse is pure syntax;
agent-edit assigns refs after parsing. Spelling outside a prepared scope throws
under test and emits a diagnostic in production.

A whole-document write aligns assigned nodes against the runtime copy through
agent-edit, so unchanged items retain identity and concurrent admissions merge
as peers. Do not lower it with a whole-fragment state-vector diff: that loses
provenance and can reattribute kept prose. Durable projection and trail actions
serialize a private scratch document from the committed update, never a warm
live room that a WebSocket may mutate during serialization. Push completion
derives its projection from the durable journal at completion time; a prepared
push commit never carries a Markdown projection or live snapshot.

## Checkpoints and ingress

Checkpoints are host-minted `CapturedCheckpointCut` values. They cover every
journal row through their cut; a free state-vector/watermark pair and warm-room
bytes are not checkpoint authority. Materialize outside the persistence lock,
then revalidate authority identity, generation, and retention under lock.
Stale checkpoint requests return `stale_generation`.

Seed and compaction snapshots use the same mutation lock. A first seed is
initialize-only, becomes the generation's base checkpoint, and reconciles an
already open room before success. Writer admission rejects reserved client IDs
and reserved provenance namespace mutations before append or Yjs apply.

WebSocket admission checks the declared schema major/minor against the specific
live or Work-draft head for each connection. Patch differences do not gate;
major incompatibility and a client behind the head use the typed transport
closures. Head and draft schema stamps are monotonic, so a rolled-back server
never lowers the durable version. Transport close mechanics belong to the
server transport boundary, not this document engine.

A missing or unregistered persisted filetype deliberately uses the document
schema; a registered binary or custom filetype on a tracked journal returns
`corrupt_state` from Result-returning surfaces rather than escaping as a
rejected promise.

## Downlinks

- [ContextFS contracts](../../context/.context/CONTEXT.md)
- [Collab shared contracts](CONTEXT.md)
- [WebSocket concurrency](websocket-concurrency.md)

## Fresh copied documents

`readCopySource` projects live PMNodes and their revision from one durable read.
`seedFromNodes` installs them only into a document without authority and defers
room delivery until commit. Whole-document model copy and initial seeding use
agent-edit's `materializeDocument`, which inserts nodes with fresh CRDT and
block binding identity, retaining stored link refs. Never initialize a copy by
applying the source's Yjs updates or by Markdown roundtripping its nodes.
