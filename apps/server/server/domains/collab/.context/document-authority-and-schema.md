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
it. Persistence revalidates both under the document mutation lock (a writer frame, under the head row
its counter bump holds) and drops stale bytes instead of relabeling them. Restore retires warm handles and
rooms; late load and connection completion revalidate before use.

## Only explicit creation makes a head

`adapters/drizzle-document-authority-head.ts` is the one writer of
`document_yjs_heads`: `initializeHead`, `allocateAdmission`, `advanceHead`
(with `checkpointId` when a checkpoint insert moves it), `retireThrough` and
`replaceGeneration`. Each write that moves a head proves in its own statement that some tree view
shows the document (`livingDocumentSql`, exported by context's `tree/living-document.ts`: a
live row not in Trash, or a Work's row that is not deleted), so a removal that won the
document mutation lock refuses it at no extra query; a tree list's head is exempt. The
retention job's purge deletes the heads of documents whose content it released.

A head and its first checkpoint are written by one initialize-only primitive,
`InitialDocumentSeeds.seedInitialDocument`: under the document mutation lock it
proves the document is living (`requireLivingDocument`), writes nothing when any
checkpoint or update exists, and otherwise calls `initializeHead` and installs
the first checkpoint. Two kinds of caller reach it: the create's own
transaction (live create, an exceptional Work drafted create, bootstrap and seeds
through `seedFromMarkdown`, or `ensureDocumentAuthority` for an empty create),
and explicit repair of a living document whose authority is absent (the same
`ensureDocumentAuthority`, seeded as an empty document: it reads first and
writes only when the document has no state).
Repair runs on a document text read (Markdown or export), live overwrite, the held
live lease, and Hocuspocus room admission before its first generation read. A client
can create a tree node without ever opening its text room; that document has no
authority yet and reads as empty. Text reads use the same initialize-only repair
as room admission, so they neither mistake it for a missing document nor overwrite
text that arrives concurrently.
Everything else requires an existing head and creates nothing. A miss answers `DocumentNotFoundError`, carrying the removal record
(`removal`) when the document was removed.

A bulk create (Copy) installs the first states of documents its own transaction just
inserted through `InitialDocumentSeeds.seedInitialDocuments`: checkpoints, then heads that
already name them, one statement per batch of 500. It takes no mutation lock and proves no
liveness, because nothing else can reach those ids yet; the unique keys on the head and on
the seed checkpoint refuse a document that already has one. The state is encoded earlier by
`encodeSeed` (the same insertion `seedFromMarkdown` makes) and installed through
`installSeeds`, which derives nothing: the caller refreshes projections after its
transaction commits.

A drafted tree create classifies its documents under sorted mutation keys. Only an ID
without a head, checkpoint or update uses `installSeeds` with empty state. Existing or occupied
IDs follow the single-document authority path, so restored creates and pre-seeded content
survive.
The list key fences the branch lifecycle until commit; ownership and liveness still apply.

`allocateAdmission` is the one live-write boundary (journal): a
removal that won the mutation lock refuses every later frame, model write
and press there.

A deleted document keeps its head and history for Restore, so an existing head
is not a document that may change. Head reads say which they mean:
`findDocumentAuthorityHead` / `readDocumentAuthorityHead` (nullable / required)
read a retained head for history; with `{ living: true }`, read under the
mutation lock, they gate every other door that mutates retained history:
version replacement and an explicit checkpoint refuse with the record; a
background checkpoint store and compaction do nothing. `advanceHead`, which
every checkpoint insert passes, is the backstop. A press reads committed
live through the mutation-locked journal read; no live fingerprint or review revision token
fences it. Journal-row edit links (`document_yjs_updates.edit_id`) are written
only beside the admission that inserted the row. Reads of a deleted document's
history stay open; only purge deletes it.

A removal refuses as a `DocumentNotFoundError` carrying the removal record, so
every not-found mapping, including a model's read, answers a removal as
`document_not_found` with who removed it (status and words once, agent-edit's
`removedFile` in `removal-copy.ts`). A model's text edit, undo or revert the
removal stopped is not refused: it is a `done` row that says `returned` with
`document_removed` and the record in `returned.removal` (agent-edit's
`returnedWriteResult`), which the chat's card words. It is answered from an
identity the call already holds (the document the write resolved to, or the node the model
was shown); a write by a path that no longer resolves stays `document_not_found`.

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
under the project's list key and returns `stale_target` when its occupant changed.

`agent-edit-runtime.ts` builds the codec once. Every serialization door gets a
holder-bound `DocumentLinkScopes` snapshot and prepares the refs it will spell
before synchronous serialization. Scope snapshots are operation-local and
never cached across reads, accounts, threads, or moves. Parse is pure syntax;
agent-edit assigns refs after parsing. Spelling outside a prepared scope throws
under test and emits a diagnostic in production.

A whole-document write aligns assigned nodes against the runtime copy through
agent-edit, so unchanged items retain identity and concurrent admissions merge
as peers. Do not lower it with a whole-fragment state-vector diff: that loses
provenance and can reattribute kept prose. Durable projection actions
serialize a private scratch document from the committed update, never a warm
live room that a WebSocket may mutate during serialization. A press
records that committed live projection in its own transaction; see [the press](press.md).

## Checkpoints and ingress

Checkpoints are host-minted `CapturedCheckpointCut` values. They cover every
journal row through their cut; a free state-vector/watermark pair and warm-room
bytes are not checkpoint authority. Materialize outside the persistence lock,
then revalidate authority identity, generation, and retention under lock.
Stale checkpoint requests return `stale_generation`.

Every server authority doc and every materialization of one (live
docs, rooms in `yjs-ws-handler.ts`, clones, scratch docs) is `gc: false`, and a
rewrite never encodes a gc-on doc. `createDocFromSnapshot` throws on a gc-on
origin, and a store that has already garbage-collected restores the wrong text
without an error. The frontier probe pins only the Yjs library behavior; it
cannot catch a server fold that starts encoding a gc-on doc.

Under `gc: false`, setting a `Y.Map` key to the value it already holds is not a
no-op: it writes a new item and a tombstone, a journaled update and eventually a
checkpoint. Skip a write whose value is unchanged, and guard set-once keys with
`!map.has(key)`.

Loading a document applies its checkpoint, then every update since. The store's
debounce (`debounce: 2000`, `maxDebounce: 10000` in `yjs-ws-handler.ts`) writes
a checkpoint during active editing, so the replay window stays short and load
needs no checkpoint step. Projections (`document-derivations.ts`) derive AI
writes and seeds at once and writer typing 2 s after typing stops, at most every
10 s; no reader needs them fresh, because readers read live Yjs.

Seed and compaction snapshots use the same mutation lock. A first seed is
initialize-only, becomes the generation's base checkpoint, and reconciles an
already open room before success. Writer admission refuses no client ID and no
Yjs root: nothing on the server writes under a fixed client ID or into a root of
its own, so a writer frame has nothing it could collide with.

WebSocket admission checks the declared schema major/minor against the document's
head for each connection. Patch differences do not gate;
major incompatibility and a client behind the head use the typed transport
closures. Head schema stamps are monotonic, so a rolled-back server
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
