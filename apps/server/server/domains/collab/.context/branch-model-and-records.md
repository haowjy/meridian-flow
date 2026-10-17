# Collab — branch model and durable records

This page defines the durable vocabulary and provenance boundaries for Work
drafts, branches, review items, and publication records. Do not use a draft ID,
branch ID, item key, or presented address interchangeably.

## Vocabulary

| Term | Meaning | Wire identity |
|---|---|---|
| **draft** | One active Work review draft; Apply leaves it open, whole Discard and purge close it. | `draftId` |
| **branch** | One document's Work-draft Y.Doc and its thread peers; generation advances on reset. | opaque branch room plus generation |
| **revision** | The branch row's write fence: moves with every committed write, status or hold change and Work lifecycle transition; never reaches a client. | none |
| **checkpoint** | The branch's stored state, with the highest journal id it contains (`checkpoint_seq`). | none |
| **tail** | The current generation's journal rows past the checkpoint, replayed on every read. | none |
| **item** | One document's reviewable change, including an empty create or image. | `${draftId}:${documentId}` |
| **command** | One idempotent writer Apply or Discard action. | `commandId` |
| **presented address** | The writer's Work/item/change selection; it names no branch. | review selector |

There is at most one active Work-draft branch per `(documentId, draftId)`.
Thread peers fork from that branch and share its upstream. The server resolves
every item key through the identity module; no caller accepts an ambiguous bare
ID. A document with no branch can still be an item and can still be applied.

## Lifecycle and publication

Draft capture, Apply, Discard, and redo require an active Work under the shared
lifecycle row lock and grant confirmation. Discard runs as one attempt: it locks the Work, draft, namespaces, and documents, then resets
selected text from live (a fold over every row appended since its read) or
closes the whole draft, then ends the draft's use of created
nodes. Peer rooms retire after commit, only for branches actually reset or
closed. Work purge reuses this kernel after proving its lifecycle set.

Draft HTTP routes share one Work-access check: a deleted Work is 404 before any
draft read or mutation, while an archived Work still permits review reads. An
archived Work's drafts are frozen to their writer: no frame, Apply or writer
Discard writes them until unarchive. Live→draft pulls keep rebasing them, so
their base stays current and they apply cleanly after unarchive; see
[CONTEXT.md](CONTEXT.md). Replaying an already committed push
returns its durable receipt without reauthorizing a new write.

Apply and Discard are server commands, not client loops. Apply item and
per-change commands leave the draft open. Whole Apply and whole Discard name
the draft once. Reusing a `commandId` returns its recorded result without
reapplying it. A per-change command on a whole-document-only item refuses
`whole_item`.

A durable thread peer has no unpublished authored state after reply finalization:
its writes enter the shared Work draft atomically. Before a new call, pull tests
whether the parent contains the peer's complete update, including deletes. A
retired peer is reset rather than merged back. A rebind closes the old peer and
creates a peer in the new Work's draft under the conversation lock.

## Provenance and review identity

Attribution comes from persisted branch rows and live journal metadata, never
from warm runtime maps, text similarity, or block proximity. Review closure
joins visible hunks with physical rows, Yjs origin/parent references,
delete-set overlaps, and same-client clock prefixes. Independent writer edits
remain independent when no dependency connects them. Agent writes journal their
own transaction deltas; state-vector diffs must not recreate cumulative
`tombstones` as authored rows.

Source row IDs identify logical attribution. Physical row IDs identify every
row needed to replay a class, including invisible suppliers and inverse rows.
They are distinct internal identities and neither is wire data. Writer review
clients rotate across independent closure classes, not merely on pauses or
selection movement.

A certified whole-block carry validates output length and one adjacent visible
replacement; partial or ambiguous matches fail closed. Restoration aliases
come from certified retained identities and exact anchors. Equal text or equal
length is not authorship evidence. Browser Undo/Redo allocates fresh writer
clocks and sends restoration claims that are untrusted: only claims whose
content, range, retained source, and anchor certify under the admission lock
grant aliases, and any other claim's bytes are admitted as writer text. A rich
restoration may lose AI attribution rather than guess, and ambiguous
correspondence never credits writer text to the AI.
A removed live block is named by its Yjs item, which a draft re-forked from live
keeps when the deletion is discarded, so a held review can find the restored
block. Incomplete ownership remains unclassified
and cannot become invented AI credit.

## Branch store

A branch's content is its checkpoint (`state`, `state_vector`) replayed with its
tail. `readBranchAt` reads the row, the checkpoint, and the tail in one
statement, and nothing else reads `state`. `revision` is the only write fence,
and every committed write moves it: appends, checkpoint rewrites, closes, and
every change to a review-membership input (`has_effect`, `blocking`, a row's
status in either direction). `generation` stays the re-fork epoch that names
rooms and groups rows and placements.

The contract (row, read and write types, the `BranchStore` port, the
materialization of one read) is `domain/branch-store.ts`. Its Drizzle storage
half is `adapters/drizzle-branch-storage.ts`: the row with its derived Work
lifecycle, `readBranchAt`, and the content primitives `appendRowsWithinTx`,
`commitRewriteWithinTx` and `insertJournalRows`. Every metadata write outside
content (a close, the hold flag, a journal row's status flip, a Work lifecycle
fence, Apply staging's revision check) goes through one door,
`bumpBranchRevisions` in `shared/branch-revisions.ts`: lock the rows in id
order, bump `revision` with the change, optionally only at an expected
revision. `createDrizzleBranchStore` wraps them with each write's application
half (Work admission, the pending projection, the live advisory lock, the
effect refresh, edit receipts). These branch writes stand outside the doors,
by name: creation and its seeds insert the row (`ensureDraftBranch`,
`ensureThreadPeerBranch`), retraction and tree deletion delete it, and two
paths write directly, both owned by the selective-review server path that the
re-landing diff-based review ([#862]) deletes: `refreshDraftEffect`'s conditional
`has_effect` bump and selective Discard's survivor re-journal.
Thread-peer and Work-draft resolution return metadata only (id, generation,
status, lifecycle); content is read through the coordinator.

Writes go through two doors. `appendRows` adds rows past the checkpoint at the
judged revision, allocating their ids under the row lock. `commitRewrite` writes
a new checkpoint covering every row of the branch, under an `exact` policy (the
revision it was computed at) or a `fold` policy (any appends since its cursor are
applied, or discarded by a reset). Pulls, resets, selective Discard, the
inverse's merged draft, a peer's checkpoint, and compaction are rewrites. A reset
also discards the generation's pending rows and adds the checkpoint's and the
tail's clocks to `discarded_state_vector`. Compaction folds the tail into a new
checkpoint with unchanged content and leaves `updated_at`. The coordinator
schedules it in the background when a committed writer frame leaves more than
512 tail rows or 2 MiB of tail.

A branch's `lifecycle` (`active`, `archived`, `deleted`, `missing`) is read from
its draft's origin Work with the row; anything but `active` is frozen. The
append's `UPDATE` admits only while that Work is active, in the same statement,
so an append whose statement starts after an archive commits gets zero rows. A
lifecycle transition also locks and bumps every active branch of the Work in
its own transaction: an append judged before the archive, even one whose
statement queued behind it, misses its revision; one that commits first lands
before the archive, as a key typed just before it does. The coordinator holds one immutable replica per branch at a
committed revision and catches it up from the tail; every write computes on a
private copy, so a failed commit never changes what a reader holds.

## Durable records and checkpoints

The live journal is the durable content source. A branch is stored as a
checkpoint plus its tail; branch write rows carry review status. `push_lineage`
provides publication identity and idempotency. The change trail is the durable
publication record; a `system:reconcile` row carries causal replay coverage
without becoming a semantic author or inverse target. Immutable edit parts keep
authored identity through settlement.

Pending-publication counts are distinct pending documents per Work (the active
draft's branches with reviewable rows plus its change rows, so a created
document counts before it has text), never raw journal-row totals. Tree
presence comes from context's tree views, never a Yjs manifest.

Live-to-draft pulls run independently of the caller's response transaction and
publish to loaded branch rooms after durability. Checkpoints are a separate
authority concern: a room release queues its immutable binding, and a worker
captures a durable cut after the releasing transaction commits. A dropped or
late checkpoint costs replay time, never data.

Branch mutations are durable before Hocuspocus apply, broadcast, or ack. The
awaited admission path validates authority/generation, exact containment, and
fresh provenance, then appends at the revision it judged. `onChange` does not
own branch persistence. The transport layer only authenticates, adapts peers,
and delegates this ordering.

A peer reconstructed from journal rows is integrable only after every row has applied with no pending structs and no pending delete set. State-vector equality, or a pending-struct check before applying, is not enough.

[#862]: https://github.com/haowjy/meridian-flow/pull/862
