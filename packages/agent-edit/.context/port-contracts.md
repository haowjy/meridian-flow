# Port contracts

These ports keep agent-edit reusable: the kernel owns editing semantics while
the host owns persistence, authority, destinations, and application policy.
Never add server, route, auth, or Work concepts to these interfaces.

## Durable and coordination ports

### `UpdateJournal` (`src/ports/update-journal.ts`)

The journal appends, batches, reads, compacts, and reserves per-document/thread
write ordinals. Agent-edit itself only reads it (`AgentEditJournal`: ordinals,
`read`, attribution and destructive provenance); rows append through the host's
save (`StagedWriteCommit.persist`). One logical edit may expand to ordered rows. `read` returns a
checkpoint and retained updates in order; `since` does not hide retained rows
behind a newer checkpoint. A persistence watermark includes the checkpoint cut
even when no rows remain above it. The host, not this package, mints captured
checkpoint cuts. Compaction never expires immutable receipts or lineage.

Undo/redo state is not transport state. `DocumentEdits` reads immutable parts
and delegates stack policy to the host's inverse policy, after the reply's
save boundary and never through the draft journal facade or staged-write
queue. There is no reconstruction-based reversal endpoint or reserved undo
client.

### `DocumentCoordinator` (`src/ports/document-coordinator.ts`)

`readRoom(docId, staged, access)` is every model call's read: a disposable
copy of the room the host holds (`doc`, the `room` label it read, its
`generation`), with the edit scope's staged entries reconciled against the
scope's first-stage snapshot cut. The host answers which entries it `kept`
(applied to the copy) and which it `rejected`, with reasons; a rejected entry
leaves the scope and never reappears. A live host reads without taking the
document's mutex; a draft host rebases live into the Work draft first, then
copies the Work draft replica. A bound call whose draft a Discard took throws
`DocumentAccessLostError(reason)`.

`prepareSave` is the one way any write lands, a reply's save and a write
outside a reply (`saveNow`, a one-entry save) alike, for both hosts: the same
reconcile as `readRoom` against the scope's cut (a live host keeps every
entry), the `room` it saves into (null for a document the save creates, which
records no frontier), the before and after states, and a required `write`:
either a `StagedWriteCommit` the caller owns (`persist` inside the commit
scope, `transfer` once that scope completed, `dispose` on any unwind; the host
installs the write at root commit, never at `transfer`, or at once outside a
transaction), or an explicit `{ kind: "no-effect" }`, which the committer
refuses when it kept entries. The result's before and after states are the
prepared candidate's, read before any lock; only a check that must refuse
before anything persists reads them (a create that lands only in an empty
document). `persist` resolves the append's actual cut (`SaveCut`), captured
inside the append where the host serializes it, before its transaction
commits, for every outcome (appended, contained, or nothing new): someone
else's rows that landed after preparing are in its before state. Nothing
fallible runs between the rows becoming durable and `persist` resolving, so a
stored write is never reported as a failed one. Receipts, commit-time
detection, revision and frontier read that cut, for both hosts; the rows are
Yjs updates and land the same either way, so a moved base refreshes the report
rather than the write. A live host's `persist` appends the kept entries as one
journal batch, and `appendBatch` returns each document's state as it found it
under the lock (`beforeState`); its install is delivery to open editors,
whenever entries were kept. A draft host's append is finalized under the draft
row lock against the committed prefix, which is its cut; a fully contained
append's before and after are both that prefix. Neither host fences a WebSocket transport from
this port: nothing applies to a live room inside a transaction (LOCK-WS, collab
`websocket-concurrency.md`). An ordinary CRDT write commits as an unfenced
append. Whole Discard
retires only the addressed peer/document epoch. A host's response-attempt
surface (`ResponseCommitAttempt`, `ResponseAttemptStaleError`) is exported
once, from `integration.ts`.

### `DocumentLifecycle` (`src/ports/document-lifecycle.ts`)

`ensureDocument(docId)` idempotently creates a missing document without
clobbering content. It is optional; a deployment without creation returns
`invalid_write`, not a thrown not-found. The port carries only a string ID.

## Content and identity ports

### `AgentEditCodec` (`src/codec-adapter.ts`)

The codec delegates parse/full serialize and block-body normalization to
`@meridian/markup`, then adds hash-prefixed display forms. Hashes are rendered
from the current sibling set and are not durable identity. A command receives
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
identity lookup, visible text, structural mutation, inline replacement,
projection, and block serialization. v1's implementation is y-prosemirror;
host composition supplies its schema explicitly.

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

Multi-block callers use batch model operations for IDs, projections, hashline
serialization, and block bodies; per-block helpers rescan the document and can
be quadratic. A logical write reserves one ordinal before staging, and the
journal's batch append owns row expansion. Tests should exercise the batch seam,
not rebuild the same walk in each caller.
