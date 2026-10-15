# collab TODO

Open follow-ups must preserve immutable edit identity, durable authority fences,
and the one push/discard kernels.

## Connection ownership

Audit paths that hold a pooled connection while acquiring another:
`ensureThreadPeerBranch` when called from an ambient transaction and
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
changes, the full-state branch CAS, and the final concurrency fence intact.

## Unused columns left by the diff-based review landing

`branch_write_journal.reviewed_by`, `reviewed_at` and `pushed_at` have no writer;
retiring them needs a migration, and `push_lineage.journal_ids` (`NOT NULL`,
written `'{}'` by content members) can go with it.

## Empty text branches stay open

A text branch whose draft equals its base stays active (its room, history and
next proposal's identity survive), and every live edit rebases each active text
branch. `gc: false` histories grow until Discard all, archive or purge. Measure a
long-lived Work before choosing an idle close.

## A blocked settlement batch stops its document's rebases and Applies

`blocked` is reserved for corrupt durable authority. A blocked batch fences
rebases and Applies (`settlement_unfinished`) on its documents until a human
repairs it; there is no repair tool or withdrawal path yet.
