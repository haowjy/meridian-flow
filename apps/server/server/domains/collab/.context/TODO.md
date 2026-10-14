# collab TODO

## Paths that hold a pooled connection while taking another

The live-pull deadlock (10 concurrent pulls each held a root transaction and
waited for a second connection) is fixed by snapshotting first. These paths
still hold one connection while acquiring another, on purpose for lock
order, so enough concurrent callers can exhaust the pool the same way:

- `ensureThreadPeerBranch` in `adapters/drizzle-branches.ts`: with no ambient
  transaction it takes the thread lock and writes in one root transaction.
  Called inside an ambient transaction, it holds that connection for the
  thread lock and opens a separate root transaction for the writes.
- `createDeferredLiveProjectionCoordinator.withDocument` in
  `adapters/hocuspocus-coordinator.ts`: inside a response transaction, reads
  committed state on a second connection.

Reproduce each with more concurrent callers than the pool's size (the PR 2
perf bench's item 9 shows how), then restructure so no path waits for a
connection while holding one. See
[file-policy performance](../../file-policy/.context/performance.md).

## Code files become a display lens; cross-schema rename becomes a metadata flip

The client mounts a constrained schema for code with exactly one `code_block`
(`config.ts` `CodeDocument`), and `markdown-document.ts` serializes code
verbatim from block 0 only. Document ↔ code renames return typed
`invalid_operation` (`context-fs.law` tests) because remounting the
other schema against existing content could let ProseMirror normalization
delete it.

The desired end state in [#212](https://github.com/haowjy/meridian-flow/issues/212)
uses one schema everywhere. Code becomes presentation, input policy, and
line-oriented verbatim serialization rather than a mounted schema. Disable
prose affordances through commands, paste, and transaction filters, not schema
node removal; then md ↔ py rename is a metadata flip and `CodeDocument` plus the
block-0 serializer are deleted.

**Affected paths:** app editor `config.ts`, collab
`domain/markdown-document.ts`, context filetype moves, and their schema and
round-trip tests.

## Cold-start concurrent journal scan

`listConcurrentJournalRows` in `adapters/drizzle-branch-push.ts` has no lower
bound without an attribution watermark. The watermark advances only for novel
attributed rows after a successful branch commit; ordinary writes whose history
is already in the baseline can keep scanning indefinitely. Snapshot containment
skips replay, not the query or update decoding. A future floor must follow push
visibility: maximum journal ID is unsound because allocation order is not push
order.

## Thread-peer pull cost on every drafted write

Profile before changing. `threadPeerContext` in
`domain/thread-peer-core-pool.ts` calls `pullThreadPeer`
(`domain/branch-pulls.ts`) on each drafted call outside an open response
document. The pull encodes a full live snapshot, rebases the Work draft onto
live's certified cut, then reads the whole branch for the attribution baseline.
Span runs on 2026-10-08 (500-document seed, before the content rebase)
measured 96–131 ms for a first write and 90–162 ms for later writes; re-measure
with the rebase in the path. Cost grows with retained Yjs bytes in this workload;
Work-size scaling was not measured.
Likely direction: reuse coherent captured live and peer state, and coalesce redundant
root pulls. Keep the pull-time baseline and the final fence intact. Evidence:
`experiments/draft-write-perf.md` and `experiments/spans-tables.md` in the
docs repo's `model-tool-surface` work item.

## Retained-state cost after attribution shortcut

The 2026-10-08 repeated overwrite/restore probe still shows a later-write slope
after attribution falls to single-digit milliseconds. Profile full-state
materialization, encodes, persistence, and thread-peer checkpointing in
`domain/branch-coordinator.ts` before choosing incremental update/checkpoint
storage. Preserve the final concurrency fence, the full-state branch CAS, durable recovery,
and delete-only changes. This is the remaining owner of the unfulfilled overall
approximately 10% later/first target, alongside the peer pull task above. Evidence:
`experiments/draft-speed-fix-probe.md` in the model-tool-surface work item.

## Unused columns left by the diff-based review landing

`branch_write_journal.reviewed_by`, `reviewed_at` and `pushed_at` have no
writer; retiring the columns needs a migration, and `push_lineage.journal_ids`
(`NOT NULL`, written `'{}'` by content members) can go with it.

## Empty text branches stay open

A text branch whose draft equals its base stays active (its room, history and the
next proposal's identity survive), and every live edit rebases each active text
branch on the document. `gc: false` histories grow until Discard all, archive or
purge. Measure the cost on a long-lived Work before choosing an idle close.

## A blocked settlement batch stops its document's rebases and Applies

`blocked` is reserved for corrupt durable authority. A blocked batch fences
rebases (`fenced`) and Applies (`settlement_unfinished`) on its documents until a
human repairs it, and its command observes as `blocked`. The settlement owner
reports the block once (`settlement.batch_blocked`); there is no repair tool or
withdrawal path yet.
