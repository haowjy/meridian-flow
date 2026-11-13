# Port contracts

Each port's shape and method comments are in `src/ports/`. These are what a host
must do that the types can't say.

## `UpdateJournal`

`read` returns a checkpoint and the retained updates in order; `since` does not
hide retained rows behind a newer checkpoint, and a persistence watermark includes
the checkpoint cut even when no rows remain above it. The host, not this package,
mints captured checkpoint cuts. Compaction never expires immutable receipts or
lineage.

## `DocumentCoordinator`

**`readRoom`.** A rejected entry leaves the scope and never reappears. A live host
reads without taking the document's mutex; a draft host rebases live into the Work
draft first, then copies the Work draft replica.

**`prepareSave`.** It reconciles as `readRoom` does; a live host keeps every entry.
The host installs a write at root commit, never at `transfer`, or at once outside a
transaction. `persist` captures the save's cut inside the append, where the host
serializes it, before its transaction commits, for every outcome (appended,
contained or nothing new). Nothing fallible runs between the rows becoming durable
and `persist` resolving, so a stored write is never reported as a failed one. The
rows are Yjs updates and land the same whatever the cut, so a moved base changes
the report, not the write.

**`SavePrecondition`.** A check before the lock would let two concurrent creates,
or a create and a writer's frame, both land, so nothing judges it before the append,
and a failure appends nothing even inside an ambient transaction. A live host's
`appendBatch` judges it on each document's state under the lock. A draft host
finalizes its append under the draft row lock against the committed prefix, which
is its cut and what `finalizeAppend` judges; a fully contained append's before and
after are both that prefix.

Neither host fences a WebSocket transport from this port: nothing applies to a live
room inside a transaction. See the [WebSocket concurrency
contract](../../../apps/server/server/domains/collab/.context/websocket-concurrency.md).
Whole Discard retires only the addressed peer or draft; it never transfers a staged
write to a replacement draft.

## `AgentEditCodec`

The immutable block-origin map travels with every room copy, snapshot planning view
and inverse cut, including deleted-block listings. A command takes one scoped codec
at entry and passes it to every serialization door; the package has no default
Meridian schema.

## `DocumentLinksPort`

Save-time replicas are disposable and are released even when link preparation
fails. An unprepared ref, settlement or address is a snapshot miss, never an
invented location.

## `AgentEditModel`

`projectBlocks` runs the binding's repair (`@tiptap/y-tiptap`) on the document it is given (an
unbuildable element is deleted and hashes cover the survivors), so hand it a private
copy, never a shared document. The resolver projects once, first; its scopes, hashes
and anchors index that repaired list, and a whole-document write takes its scope
from it, never from a count taken earlier.

`id` is the local CRDT item, used for mutation and provenance. `hash` and `fullHash`
come from the block's origin identity, which differs from `id` for a Work-draft block
seeded from live, so hash lookup matches `fullHash` and never rebuilds a hash from
`id`.

## `AgentEditCore`

`responseIdentity` separates provider authorship from the rotated edit scope.

## Performance

Multi-block callers project once and serialize from that projection; per-block
helpers rescan the document and can be quadratic.
