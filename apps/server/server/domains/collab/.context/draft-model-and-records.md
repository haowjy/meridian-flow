# Collab — draft model and durable records

This page defines the durable vocabulary and provenance boundaries for Work
branches, drafts, review items, and Apply records. Do not use a branch ID,
draft ID, item key, or presented address interchangeably.

## Vocabulary

| Term | Meaning | Wire identity |
|---|---|---|
| **branch** | One active Work branch; Apply leaves it open, whole Discard and purge close it. | `branchId` |
| **draft** | One document's pending version (`work_draft`), one Y.Doc with stable identity from seed to close. Legacy `thread_peer` rows retain binding identity only. | opaque draft room |
| **revision** | The draft row's counter: every append, rewrite and close moves it; exact rewrites check it, folds absorb intervening appends, and appends never check it; never reaches a client. | none |
| **checkpoint** | The draft's stored state, with the highest journal id it contains (`checkpoint_seq`). | none |
| **tail** | The draft's journal rows past the checkpoint in id order, replayed on every read. | none |
| **item** | One document's reviewable change, including an empty create or image. | `${branchId}:${documentId}` |
| **command** | One idempotent writer Apply or Discard action. | `commandId` |
| **presented address** | The writer's Work/item/change selection; it names no draft storage ID. | review selector |

There is at most one active Work draft per `(documentId, branchId)`.
Thread-peer bindings name that draft as their upstream; they hold no independently
maintained document view. The server resolves
every item key through the identity module; no caller accepts an ambiguous bare
ID. A document with no draft can still be an item and can still be applied.

## Lifecycle and Apply

Work admission and reply writes still require the shared Work lifecycle boundary.
There is no server review, staged Apply, selective Discard or draft reset.
Atomic Apply commits frozen clicked content into live and the review base
together; see [Apply](apply.md). The browser owns room-derived review and local
undoable text Discard. Per-document server Discard only ends a still-hidden creation's
branch use. A revealed creation answers `stale`; Work Discard all and purge close
drafts and run end-use removal without re-forking text.

Thread peers retain binding identity only: no content pull, peer-bound write
or exact catch-up checkpoint runs. Model reads and saves use the Work draft.
`ThreadPeerPullLost` names a failed binding/save fence, not a content pull; a
retired binding never redirects its staged writes to a replacement draft. Archived Works admit reads but no new writer edits.
`DraftReplayJournalReads` lives in `drizzle-draft-journal-reads.ts`; both reads
use the ambient transaction, including the reply's uncommitted receipts.

## Draft store

A draft's content is its checkpoint (`state`, `state_vector`) replayed with its
tail. `readDraftAt` reads the row, the checkpoint, and the tail in one
statement, and nothing else reads `state`. Every committed write moves
`revision`: appends, checkpoint rewrites and closes. Exact rewrites check the captured revision; fold rewrites absorb intervening
appends. Closes lock and bump it; appends bump it without checking it. The projection job's `has_effect` write is the one
exception: it writes at the judged revision and never bumps it, so it never
makes an exact rewrite miss. Draft room identity is `draft:<draftId>` for life; journal rows and receipt origins carry no epoch.


The contract (row, read and write types, the `DraftStore` port, the
materialization of one read) is `domain/draft-store.ts`. Its Drizzle storage
half is `adapters/drizzle-draft-storage.ts`: the row with its derived Work
lifecycle, `readDraftAt`, and the content primitives `appendRowsWithinTx`,
`commitRewriteWithinTx` and `insertJournalRows`. The only metadata mutation
outside content is the shared close (`drizzle-draft-close.ts`): lock active
Work drafts before peers, each in id order, then set closed status and cause
while bumping `revision`. Closing writes no receipt disposition or journal status;
Apply evidence and the retained text decide each part's disposition. `createDrizzleDraftStore` wraps them with each write's application
half (Work admission and the Works mutation boundary for every write except an
append, the live advisory lock, the projection job's effect write, edit
receipts). An append takes only its draft row. These draft writes stand outside the doors,
by name: creation and its seeds insert the row (`ensureDocumentDraft`,
`ensureThreadPeerDraft`); retraction and tree deletion delete it.
Thread-peer and Work-draft resolution return metadata only (id, status, lifecycle and immutable
seed provenance); content is read through the coordinator.

Writes go through two doors. `appendRows` adds rows past the checkpoint,
sequenced by the draft row's lock rather than fenced by a revision: it bumps
whatever revision the row holds, allocates the ids under that lock, and
finalizes the update against the committed prefix there (see the append
contract in [CONTEXT.md](CONTEXT.md#transaction-and-lock-contracts)). `commitRewrite` writes
a new checkpoint covering every row of the draft, under an `exact` policy (the
revision it was computed at) or a `fold` policy (any appends since its cursor are
applied). Model turn inverses are exact rewrites; compaction is a fold rewrite.
Live-to-Work content rebases are server appends, not Yjs pulls.
No rewrite resets generations, accumulates discarded clocks or marks journal
rows discarded through reset. Compaction folds the tail with unchanged content
and leaves `updated_at`; the runtime schedules it after every committed append at 512 rows or
2 MiB, only after its root commit. Work drafts seed two fresh client-1 fragments,
`prosemirror` and `review_base`. In the same insert they retain the live room, the live and draft seed snapshots, the paired live journal position and state, and the live-origin map for copied top-level blocks. Those cuts project a first draft write's live observation into revision 0 and attribute any observation-to-seed gap; they never gate the write. Rows created before the state-and-position pair existed still project to revision 0 and report the seed conservatively as unattributed. The map never changes and a race loser reads the winner's record. The effect job compares their
blocks; a live commit rebases content through the same append finalizer.

A draft's `lifecycle` (`active`, `archived`, `deleted`, `missing`) is read from
its branch's origin Work with the row; anything but `active` is frozen. The
ordinary append's `UPDATE` admits only while that Work is active, in the same statement,
so an append whose statement starts after an archive commits gets zero rows,
and the post-lock read refuses one whose statement started earlier but took the
row after the archive committed. A lifecycle transition touches no draft row:
the one append it can miss is one whose post-lock read ran before it committed,
which lands in the archived draft (the archive window, `CONTEXT.md`). The
background content rebase explicitly admits archived Works to keep them current. The
runtime holds one immutable replica per draft at a
committed revision and catches it up from the tail; every write computes on a
private copy, so a failed commit never changes what a reader holds. Its cached
encoding supplies a no-tail append's before-cut; the finalized immutable doc's
lazy encoding is shared by the save cut and installed replica. Typing, rebase
and Apply do not eagerly encode an unused after-cut under the hold.

## Durable records and checkpoints

The live journal is the durable content source. A draft is stored as a
checkpoint plus its tail. `push_lineage` records each committed Apply, while
`branch_commands` claims its command id and stores the terminal outcome.
The server-owned Apply record retains applied draft identity ranges; the change
trail retains the committed live effect and canonical navigation. No staged
settlement writer or contribution-refinement path remains.

Pending counts (the Works badge) are distinct pending documents per Work (the active
branch's drafts with reviewable rows plus its change rows, so a created
document counts before it has text), never raw journal-row totals; each Work stores its count (`works.pending_document_count`), reconciled by the Works boundary. Tree
presence comes from context's tree views, never a Yjs manifest.

Live-to-Work content rebases run independently of the caller's response transaction and
deliver to loaded draft rooms after durability. Checkpoints are a separate
authority concern: a room release queues its immutable binding, and a worker
captures a durable cut after the releasing transaction commits. A dropped or
late checkpoint costs replay time, never data.

Draft mutations are durable before Hocuspocus apply, broadcast, or ack. The
awaited admission path checks active status and the room, exits early on a
contained or reserved-authorship update, then appends once; containment,
authorship and receipts are decided again under the row lock against what is
committed. `onChange` does not
own draft persistence. The transport layer only authenticates, adapts peers,
and delegates this ordering.

A peer reconstructed from journal rows is integrable only after every row has applied with no pending structs and no pending delete set. State-vector equality, or a pending-struct check before applying, is not enough.


## Pending review membership

An edited document is listed exactly while its Work draft is active and
`has_effect`; a created document remains listed independently of text.
`branch-review-items.ts` and `drizzle-work-branch-pending.ts` share that rule.
Counts and document hints read only this metadata and created tree nodes, never
receipt history or full review diffs. The review list's conversation membership
comes from the shared captured disposition reader's classification members and
receipt owners, once per draft, not journal statuses or generation.
