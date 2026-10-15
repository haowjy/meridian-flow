# collab TODO

Open follow-ups must preserve immutable edit identity, durable authority fences,
and the one push/discard kernels.

## Per-change Apply Undo

Expose per-change Apply Undo through the existing immutable edit-part and
forward-inverse authority. Apply currently confirms settlement only; this does
not need a separate reversal planner or mutable receipt.

## Connection ownership

Audit paths that hold a pooled connection while acquiring another:
`ensureThreadPeerBranch` when called from an ambient transaction and
`createDeferredLiveProjectionCoordinator.withDocument` inside a response
transaction. Restructure only if concurrency measurements show pool
exhaustion; preserve the lock order and independent root pull transactions.

## Empty-paragraph preview

Support empty text blocks in the draft-preview anchoring seam instead of
returning an internal error.

## Code representation

Evaluate moving code from a mounted constrained schema to presentation and
input policy ([#212](https://github.com/haowjy/meridian-flow/issues/212): one
schema everywhere, prose affordances disabled through commands, paste, and
transaction filters rather than schema node removal, so a document/code rename
becomes a metadata flip). Until an explicit conversion seam exists, preserve the
current schema guard and refuse document/code renames, because remounting the
other schema against existing content could let normalization delete it.

## Attribution and retained state

The concurrent-journal scan still decodes retained candidates because its floor
is a commit-bound attribution cursor, not a global maximum. Profile retained
state materialization, encodes, persistence, and thread-peer pulls before
choosing an incremental checkpoint or captured-state design. Keep delete-only
changes, generation CAS, and the final concurrency fence intact.

## Generation invalidation

Thread-peer and Work-draft generations remain independent. A reset must evict
the affected thread peers individually; audit for missing invalidation paths
before considering a unified generation API.
