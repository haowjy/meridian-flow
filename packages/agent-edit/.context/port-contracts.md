# Port contracts

These ports keep agent-edit reusable: the kernel owns editing semantics while
the host owns persistence, authority, destinations, and application policy.
Never add server, route, auth, or Work concepts to these interfaces.

## Durable and coordination ports

### `UpdateJournal` (`src/ports/update-journal.ts`)

The journal appends, batches, reads, compacts, and reserves per-document/thread
write ordinals. One logical edit may expand to ordered rows. `read` returns a
checkpoint and retained updates in order; `since` does not hide retained rows
behind a newer checkpoint. A persistence watermark includes the checkpoint cut
even when no rows remain above it. The host, not this package, mints captured
checkpoint cuts. Compaction never expires immutable receipts or lineage.

Undo/redo state is not transport state. `DocumentEdits` reads immutable parts
and delegates stack policy to the host's inverse policy, behind the
prepared-lease gate and never through the branch journal facade or staged-write
queue. There is no reconstruction-based reversal endpoint or reserved undo
client.

### `DocumentCoordinator` (`src/ports/document-coordinator.ts`)

`withDocument` runs a callback on the host's document; its mutations commit
atomically or refuse. Callers must not rely on mutual exclusion: a live host
serializes callers for one document, a branch host runs them on private
candidates. On a branch an ordinary CRDT write commits as an unfenced append;
an exact peer catch-up or rewrite commits only at the revision it captured, so
a `StagedWriteCommit` whose save includes one can still throw a revision miss.
Neither fences a separate WebSocket
transport; the host supplies that authority check. `DocumentAccess.timeoutMs`
bounds only a live host's wait. `recover` replays persisted-but-unapplied
updates and reports a missing coordinator document as `DocumentNotFoundError`.

A host that stages response writes on private candidates provides
`stagedWrites`, two operations over an explicit helper base cut. `replay` is
for reading: accepted kept entries, a replacement helper cut and the before
cut, and nothing written. `prepareSave` returns the same and a required
`write`: either a `StagedWriteCommit` the caller's attempt owns (`persist`
inside the commit scope, `transfer` once the attempt completed, `dispose` on
any unwind; the host installs the write at root commit, never at `transfer`), or an
explicit `{ kind: "no-effect" }`, which the committer refuses when it kept
entries. Prepared views are private disposable replicas, never runtime-store
entries; every content exposure passes through a prepare lease. Whole Discard
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

It maps transport identities to persistent `ActorSession` values. Membership is
an initialized-document set, not a retained state vector or attribution
snapshot. It is optional and may fall back to an in-memory map.

### `AgentEditCore` (`src/index.ts`)

The facade exposes read/write, recovery, response commit/rollback, prepared
leases, response-document discovery, and thread invalidation. The host chooses
destination, stack policy, immutable receipt persistence, notices, and
install-after-commit. `responseIdentity` separates provider authorship from
rotated helper scope. No public method reconstructs an UndoManager from journal
history.

## Performance boundary

Multi-block callers use batch model operations for IDs, projections, hashline
serialization, and block bodies; per-block helpers rescan the document and can
be quadratic. A logical write reserves one ordinal before staging, and the
journal's batch append owns row expansion. Tests should exercise the batch seam,
not rebuild the same walk in each caller.
