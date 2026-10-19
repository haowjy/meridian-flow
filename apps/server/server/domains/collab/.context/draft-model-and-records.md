# Collab — draft model and durable records

This page defines the durable vocabulary and provenance boundaries for Work
branches, drafts, review items, and Apply records. Do not use a branch ID,
draft ID, item key, or presented address interchangeably.

## Vocabulary

| Term | Meaning | Wire identity |
|---|---|---|
| **branch** | One active Work branch; Apply leaves it open, whole Discard and purge close it. | `branchId` |
| **draft** | One document's pending version: either a Work draft (`work_draft`) or a thread peer (`thread_peer`). Each is its own Y.Doc; generation fields remain until lane G. | opaque draft room plus generation |
| **revision** | The draft row's counter: every append, rewrite and status or hold change moves it; rewrites are fenced by it, appends never check it; never reaches a client. | none |
| **checkpoint** | The draft's stored state, with the highest journal id it contains (`checkpoint_seq`). | none |
| **tail** | The current generation's journal rows past the checkpoint, replayed on every read. | none |
| **item** | One document's reviewable change, including an empty create or image. | `${branchId}:${documentId}` |
| **command** | One idempotent writer Apply or Discard action. | `commandId` |
| **presented address** | The writer's Work/item/change selection; it names no draft storage ID. | review selector |

There is at most one active Work draft per `(documentId, branchId)`.
Thread peers fork from that draft and name it as their upstream. The server resolves
every item key through the identity module; no caller accepts an ambiguous bare
ID. A document with no draft can still be an item and can still be applied.

## Lifecycle and Apply

Work admission and reply writes still require the shared Work lifecycle boundary.
The old server review, staged Apply, selective Discard and draft reset are gone.
Lane A builds atomic Apply; lane B2 builds room-derived review and local undoable
text Discard. Per-document server Discard only ends a still-hidden creation's
branch use. A revealed creation answers `stale`; Work Discard all and purge close
drafts and run end-use removal without re-forking text.

Thread peers keep seed replication, pull and exact checkpoints until Track M.
A parent that no longer contains its peer refuses `ThreadPeerPullLost`, never
creates a new generation. Archived Works admit reads but no new writer edits.
`DraftReplayJournalReads` lives in `drizzle-draft-journal-reads.ts`; both reads
use the ambient transaction, including the reply's uncommitted receipts.

## Draft store

A draft's content is its checkpoint (`state`, `state_vector`) replayed with its
tail. `readDraftAt` reads the row, the checkpoint, and the tail in one
statement, and nothing else reads `state`. Every committed write moves
`revision`: appends, checkpoint rewrites, closes, and changes to `blocking` or
a row's status. Rewrites and metadata changes are fenced by it; appends bump it
without checking it. The projection job's `has_effect` write is the one
exception: it writes at the judged revision and never bumps it, so it never
makes an exact rewrite miss. `generation` still names rooms and groups rows and placements; lane G removes
that legacy state. No operation bumps it through reset.

The contract (row, read and write types, the `DraftStore` port, the
materialization of one read) is `domain/draft-store.ts`. Its Drizzle storage
half is `adapters/drizzle-draft-storage.ts`: the row with its derived Work
lifecycle, `readDraftAt`, and the content primitives `appendRowsWithinTx`,
`commitRewriteWithinTx` and `insertJournalRows`. Every metadata write outside
content (a close, the hold flag, a journal row's status flip, Apply staging's
revision check) goes through one door,
`bumpDraftRevisions` in `shared/draft-revisions.ts`: lock the rows in id
order, bump `revision` with the change, optionally only at an expected
revision. `createDrizzleDraftStore` wraps them with each write's application
half (Work admission and the Works mutation boundary for every write except an
append, the live advisory lock, the projection job's effect write, edit
receipts). An append takes only its draft row. These draft writes stand outside the doors,
by name: creation and its seeds insert the row (`ensureDocumentDraft`,
`ensureThreadPeerDraft`); retraction and tree deletion delete it.
Thread-peer and Work-draft resolution return metadata only (id, generation,
status, lifecycle); content is read through the coordinator.

Writes go through two doors. `appendRows` adds rows past the checkpoint,
sequenced by the draft row's lock rather than fenced by a revision: it bumps
whatever revision the row holds, allocates the ids under that lock, and
finalizes the update against the committed prefix there (see the append
contract in [CONTEXT.md](CONTEXT.md#transaction-and-lock-contracts)). `commitRewrite` writes
a new checkpoint covering every row of the draft, under an `exact` policy (the
revision it was computed at) or a `fold` policy (any appends since its cursor are
applied). Pulls, inverses, peer checkpoints and compaction are rewrites.
No rewrite resets generations, accumulates discarded clocks or marks journal
rows discarded through reset. Compaction folds the tail with unchanged content
and leaves `updated_at`; the runtime schedules it after every committed append at 512 rows or
2 MiB, only after its root commit. Lane R owns the surviving Work pull and `live_cut` effect projection.

A draft's `lifecycle` (`active`, `archived`, `deleted`, `missing`) is read from
its branch's origin Work with the row; anything but `active` is frozen. The
append's `UPDATE` admits only while that Work is active, in the same statement,
so an append whose statement starts after an archive commits gets zero rows,
and the post-lock read refuses one whose statement started earlier but took the
row after the archive committed. A lifecycle transition touches no draft row:
the one append it can miss is one whose post-lock read ran before it committed,
which lands in the archived draft (the archive window, `CONTEXT.md`). The
runtime holds one immutable replica per draft at a
committed revision and catches it up from the tail; every write computes on a
private copy, so a failed commit never changes what a reader holds.

## Durable records and checkpoints

The live journal is the durable content source. A draft is stored as a
checkpoint plus its tail; draft write rows carry review status. `push_lineage`
provides Apply identity and idempotency. The change trail is the durable
Apply record storage remains for lane A and the migration lane; no staged
settlement writer or contribution-refinement path remains. Committed trail
persistence, read/navigation, dirty signals and delivery survive.

Pending counts (the Works badge) are distinct pending documents per Work (the active
branch's drafts with reviewable rows plus its change rows, so a created
document counts before it has text), never raw journal-row totals; each Work stores its count (`works.pending_document_count`), reconciled by the Works boundary. Tree
presence comes from context's tree views, never a Yjs manifest.

Live-to-draft pulls run independently of the caller's response transaction and
deliver to loaded draft rooms after durability. Checkpoints are a separate
authority concern: a room release queues its immutable binding, and a worker
captures a durable cut after the releasing transaction commits. A dropped or
late checkpoint costs replay time, never data.

Draft mutations are durable before Hocuspocus apply, broadcast, or ack. The
awaited admission path checks the generation and the room, exits early on a
contained or reserved-authorship update, then appends once; containment,
authorship and receipts are decided again under the row lock against what is
committed. `onChange` does not
own draft persistence. The transport layer only authenticates, adapts peers,
and delegates this ordering.

A peer reconstructed from journal rows is integrable only after every row has applied with no pending structs and no pending delete set. State-vector equality, or a pending-struct check before applying, is not enough.

[#862]: https://github.com/haowjy/meridian-flow/pull/862
