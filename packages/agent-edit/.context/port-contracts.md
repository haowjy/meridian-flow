# Port contracts

These ports keep agent-edit reusable: the kernel owns editing semantics while
the host owns persistence, authority, destinations, and application policy.
Never add server, route, auth, or Work concepts to these interfaces.

## Durable and coordination ports

### `UpdateJournal` (`src/ports/update-journal.ts`)

The journal appends, batches, reads, compacts, and reserves per-document/thread
write ordinals. Agent-edit itself uses it for ordinals and ordinary reads; rows append through the host's
save (`StagedWriteCommit.persist`). One logical edit may expand to ordered rows. `read` returns a
checkpoint and retained updates in order; `since` does not hide retained rows
behind a newer checkpoint. A persistence watermark includes the checkpoint cut
even when no rows remain above it. The host, not this package, mints captured
checkpoint cuts. Compaction never expires immutable receipts or lineage.
`readUpdates` is the separate origin-aware interval read used for reporting; it
returns only rows in `(after, through]` and never transfers checkpoint state.

Undo/redo state is not transport state. `DocumentEdits` reads immutable parts
and delegates stack policy to the host's inverse policy, after the reply's
save boundary and never through the draft journal facade or staged-write
queue. There is no reconstruction-based reversal endpoint or reserved undo
client.

### `DocumentCoordinator` (`src/ports/document-coordinator.ts`)

`readRoom(docId, staged, access)` is every model call's read: a disposable
copy of the room the host holds (`doc` and the stable `room` label it read), with the edit scope's staged entries reconciled against the
scope's first-stage snapshot cut. The host answers which entries it `kept`
(applied to the copy) and which it `rejected`, with reasons; a rejected entry
leaves the scope and never reappears. A live host reads without taking the
document's mutex; a draft host rebases live into the Work draft first, then
copies the Work draft replica. A bound call whose draft a Discard took throws
`DocumentAccessLostError(reason)`.

`prepareSave` is the one way any write lands, a reply's save and an immediate
save (`saveNow`, a write outside a reply) alike, for both hosts: the same
reconcile as `readRoom` against the scope's cut (a live host keeps every
entry), the `room` it saves into (null records no frontier when the host cannot
name it), and a required `write`: either a `StagedWriteCommit` the
caller owns (`persist` inside the commit scope, `transfer` once that scope
completed, `dispose` on any unwind; the host installs the write at root commit,
never at `transfer`, or at once outside a transaction), or an explicit
`{ kind: "no-effect" }`, which the committer refuses when it kept entries.
Preparing reads no cut. `persist` resolves the save's only cut (`SaveCut`),
captured inside the append where the host serializes it, before its
transaction commits, for every outcome (appended, contained, or nothing new):
someone else's rows that landed after preparing are in its before state.
Nothing fallible runs between the rows becoming durable and `persist`
resolving, so a stored write is never reported as a failed one. Receipts,
revision and frontier reporting read that cut, for both hosts; the
rows are Yjs updates and land the same either way, so a moved base refreshes
the report rather than the write.

A save that must refuse on the document's state passes a `SavePrecondition`
(a create without overwrite lands only in a document with no blocks). The host
judges it inside the append, under the document's lock, on the state the rows
would follow, before anything is written; a failure rejects `persist` with
`SavePreconditionRefused` and nothing is appended, even inside an ambient
transaction. Nothing judges it earlier: a check before the lock lets two
concurrent creates, or a create and a writer's frame, both land. A live host's
`persist` appends the kept entries as one journal batch, and `appendBatch`
judges the precondition on, and returns, each document's state as it found it
under the lock (`beforeState`); its install is delivery to open editors,
whenever entries were kept. A draft host's append is finalized under the draft
row lock against the committed prefix, which is its cut and what
`finalizeAppend` judges the precondition on; a fully contained append's before
and after are both that prefix. Neither host fences a WebSocket transport from
this port: nothing applies to a live room inside a transaction. See the
[WebSocket concurrency contract](../../../apps/server/server/domains/collab/.context/websocket-concurrency.md). An ordinary CRDT write commits as an unfenced
append. Whole Discard
retires only the addressed peer/draft identity; it never transfers a staged
write to a replacement draft. A host's response-attempt
surface (`ResponseCommitAttempt`, `ResponseAttemptStaleError`) is exported
once, from `integration.ts`.

## Content and identity ports

### `AgentEditCodec` (`src/codec-adapter.ts`)

The codec delegates parse/full serialize and block-body normalization to
`@meridian/markup`, then adds hash-prefixed display forms. Hashes are rendered
from the current sibling set and are not durable identity. A seeded draft block's
address identity is its live origin item; every other block uses its own item.
The immutable origin map travels with every room copy, snapshot planning view and
inverse cut, including deleted block listings. A command receives
one scoped codec at entry and passes it to every serialization door; the package
has no default Meridian schema.

### `DocumentLinksPort` (`src/ports/document-links.ts`)

The host prepares one batched link scope for each synchronous operation,
resolves a holder/view, registers ahead refs outside transactions, and provides
the revision token. Every command names its routed view. Save-time replicas are
disposable and must be released even when link preparation fails. An unprepared
ref, settlement, or address is a snapshot miss, never an invented location.
Markup's `createHolderLinkScope` applies the contracts' resolution and spelling
rules over any host catalog (the client resolves through the same rules), so
hosts cannot disagree; the package imports no server or infrastructure code.

### `AgentEditModel` (`src/ports/model.ts`)

The model port makes document and block handles opaque to the kernel. It owns
identity lookup, visible text, structural mutation, inline replacement, and
`projectBlocks`: every top-level block as `{ ref, id, hash, node }`, built in one
walk so the four always describe the same block. Serialization is the codec's
(`serializeBlocks` records shown links; `serializeBlockBodies` does not); each
caller composes what it uses from one projection. Projecting runs y-prosemirror's
repair on the document it is given (an unbuildable element is deleted and left out,
and hashes cover the survivors), so hand it a private copy (a room copy, a planning view, a document decoded from a
stored snapshot), never a shared document. The resolver projects once, first, so its
scopes and anchors index the repaired block list.
v1's implementation is y-prosemirror; host composition supplies its schema explicitly.

## Session and facade ports

### `ActorSessionStore` (`src/ports/actor-session-store.ts`)

It maps transport identities to persistent `ActorSession` values: a stable
session id and the thread it acts for, no document state. It is optional and
may fall back to an in-memory map.

### `AgentEditCore` (`src/index.ts`)

The facade exposes read/write, `readRoom` (the effective reader's door),
response commit/rollback, response-document discovery, peer
retirement and `dropStaged`. The host chooses
destination, stack policy, immutable receipt persistence, notices, and
install-after-commit. `responseIdentity` separates provider authorship from
rotated edit scope. No public method reconstructs an UndoManager from journal
history.

## Performance boundary

Multi-block callers project once and serialize from that projection; per-block helpers rescan the document and can
be quadratic. A logical write reserves one ordinal before staging, and the
journal's batch append owns row expansion. Tests should exercise the batch seam,
not rebuild the same walk in each caller.
