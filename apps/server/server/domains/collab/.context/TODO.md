# collab TODO

Open follow-ups must preserve immutable edit identity, durable authority fences,
and the close/end-use kernel.

## Draft-review migration handoff

The migration lane must remove the final legacy insert assignments atomically
with dropping their NOT NULL columns: `placement: p.origin` in
`adapters/drizzle-document-edits.ts` and `draftBaseUpdateSeq: 0` in
`adapters/drizzle-draft-storage.ts`. Neither column has a database default;
omission before migration fails `23502`. They have no disposition authority.
Remove the unused replay DTO's `draftBaseUpdateSeq` field and its adapter mapping
with that column drop. No receipt placement mutators or readers remain.

## Per-change Apply Undo

Expose per-change Apply Undo through the existing immutable edit-part and
forward-inverse authority. Lane A builds atomic Apply; this does
not need a separate reversal planner or mutable receipt.

## Connection ownership

Audit paths that hold a pooled connection while acquiring another:
`ensureThreadPeerDraft` when called from an ambient transaction and
`createDeferredLiveProjectionCoordinator.withDocument` inside a response
transaction. Restructure only if concurrency measurements show pool
exhaustion; preserve the lock order and independent root pull transactions.

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
changes, the revision fence on draft rewrites (appends are sequenced and
unfenced), the generation fence on rooms,
and the final concurrency fence intact. [#932] tracks the provenance side:
sequence it after the diff-based review re-lands ([#862]), so nothing that
change deletes is optimized first.

## Draft store follow-ups

These mechanisms still run beside the draft store and each has an owner.
Do not port them onto the store or extend them.

- **Work projection on operations** ([#931]): keystrokes already take no Work
  lock and count nothing (the projection job does it afterward), and the Works
  mutation boundary no longer counts. Operations (pulls, Discard,
  Undo, draft creation) still lock the Work for lifecycle order and touch it in
  their own transaction. Decide whether anything of #931 remains before
  scheduling it.
- **Live documents** ([#934]) still use the in-process `withDocument` mutex,
  the advisory lock and in-place room mutation; they move to checkpoint, tail
  and revision after [#862].
- **One unit-of-work port** ([#935]) replaces the six `deferUntilCommit`
  declarations and the response-transaction participant layer.
- **Delete-only live reply** ([#933], unconfirmed): room recovery is gated on a
  state-vector change, which a delete-only update does not make
  (`adapters/hocuspocus-coordinator.ts`).

[#862]: https://github.com/haowjy/meridian-flow/pull/862
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#933]: https://github.com/haowjy/meridian-flow/issues/933
[#934]: https://github.com/haowjy/meridian-flow/issues/934
[#935]: https://github.com/haowjy/meridian-flow/issues/935
