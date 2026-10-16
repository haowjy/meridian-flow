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
and reserved provenance namespace mutations before append or Yjs apply. A text
branch's `review_base` root is server-owned the same way (`SERVER_OWNED_ROOTS`):
only the rebase, seeding and the Apply base patch write it, as
`DRAFT_SERVER_CLIENT_ID`.

WebSocket admission checks the declared schema major/minor against the specific
live or Work-draft head for each connection. Patch differences do not gate;
major incompatibility and a client behind the head use the typed transport
closures. Head and branch schema stamps are monotonic, so a rolled-back server
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
