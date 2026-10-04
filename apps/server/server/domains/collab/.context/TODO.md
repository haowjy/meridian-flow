# collab TODO

## Bound thread-core lock order across a reply's cores

A reply can hold several thread-peer cores (one per destination). Review
finding F5 flagged a possible pool starvation when replies wait on each
other's cores; not reproduced. PR 2 phase 3 (write seams and locking) sets the
lock order. Affected: `domain/thread-peer-core-pool.ts`, the response
finalizer.

## Measure `confirmEdit` on every live frame

Each frame an edit room persists binds the writer's grant, and the journal
seam runs a full `confirmEdit` inside the journal transaction: two facts
loads, the recursive folder walk and the person grants. Manuscript rooms pay
it too, although no Work lifecycle can change their access. Measure frame
latency under typing load before narrowing it, for example by skipping
confirmation when the grant locks no Work. PR 2 review, finding 7.

Affected paths: `apps/server/server/lib/yjs-ws-handler.ts` (`admitLiveSync`),
`domains/file-policy/file-access.ts` (`confirmEdit`), the journal seam in
`adapters/drizzle-journal.ts`.

## Make archived Work documents read-only in live Yjs sessions

Archived Work documents remain readable and therefore pass document access and
live-room admission. The app mounts the archived surface read-only, but the live
Yjs writer-ingress path does not consult Work lifecycle, so a direct or already
connected peer can still submit updates for durable journaling. Add a read-only
lifecycle fact to live-session admission and fence updates without revoking the
readable room.

Affected paths: `apps/server/server/lib/document-access.ts`,
`apps/server/server/lib/yjs-ws-handler.ts`, project document opening, and live
session availability contracts.

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
