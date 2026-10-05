# collab TODO

## Paths that hold a pooled connection while taking another

The live-pull deadlock (10 concurrent pulls each held a root transaction and
waited for a second connection) is fixed by snapshotting first. These paths
still hold one connection while acquiring another, on purpose for lock
order, so enough concurrent callers can exhaust the pool the same way:

- `pullThreadPeer` in `domain/branch-pulls.ts`, called inside a caller's
  transaction: its live snapshots and its `run(...)` each need a connection.
- `ensureThreadPeerBranch` in `adapters/drizzle-branches.ts`: locks the
  thread in one transaction, then opens a separate root transaction.
- `createDeferredLiveProjectionCoordinator.withDocument` in
  `adapters/hocuspocus-coordinator.ts`: inside a response transaction, reads
  committed state on a second connection.

Reproduce each with more concurrent callers than the pool's size (the PR 2
perf bench's item 9 shows how), then restructure so no path waits for a
connection while holding one. See
[file-policy performance](../../file-policy/.context/performance.md).

## Refresh the markdown projection after human Yjs writes

The WebSocket persistence path durably journals and checkpoints human Yjs
updates but does not schedule `DocumentProjectionRefresher.refresh`.
`documents.markdown_projection` can therefore remain at the pre-edit manuscript
while the CRDT head is current; AI context and any projection reader then see
stale prose. Define the post-journal projection obligation for human writes and
make it retryable without delaying each live update acknowledgement.

Affected paths: `apps/server/server/lib/yjs-ws-handler.ts`, the collab durable
projection port/adapter, and projection consumers.

## Draft preview fails on empty paragraphs

The draft-preview endpoint returns HTTP 500 when a draft contains an empty
paragraph: `Cannot anchor text offset in block <id> (paragraph) without text`.
Reproduce at the draft-preview anchoring seam and make empty text blocks a
supported preview input.

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

`listConcurrentJournalRows` has no lower bound when a branch has no previous
watermark. Production promotion advances the watermark after the first
interaction, but a simple max-id floor is unsound because journal-id order is
not push order. The unbounded pushed-row scan is the same hole. Tracked at the
query site in `branch-pulls.ts`.

## Thread-peer vs Work-draft generation split

Thread-peer branches and Work-draft branches have independent generation
counters. A reset bumps the Work-draft generation; thread peers must be
individually evicted. Missing one invalidation path reintroduces stale state.
A unified generation scheme or tiered invalidation API is the long-term shape.

## N+1 manifest resolution

Tree-level membership operations (recursive `ls`, `grep`) perform N+1 manifest
resolution lookups. Memoized per walk; the cursor-based root cause is unfixed.
