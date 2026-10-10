# Collab — branch model and durable records

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. There is at most one active Work-draft branch per
`(documentId, draftId)`; every thread peer for that document and draft shares it
as upstream and carries the same `draft_id`. A branch's Work is its draft's
origin Work, read only through `draftBranchWorks`/`branchDraftWork`
(`shared/work-draft-lifecycle.ts`); a draft with no origin Work is frozen. Pushing computes a Yjs update from branch to live, records push
lineage, marks source journal rows reviewed, and resets/advances branch
generation where needed.

Work draft capture, redo, Apply and Discard require an active Work under the
shared lifecycle row lock before durable mutation, and take the row through
`lockSeamWorks` so bound edit grants are confirmed first
([file policy](../../file-policy/.context/CONTEXT.md)). An archived Work's
drafts are frozen: captured evidence stays, and nothing writes, applies or
discards them until unarchive. Replaying
an already committed push returns its durable receipt without reauthorizing a
new write. Draft-only Discard ends that draft’s use of the hidden document and
resets its content branch in one Work-locked transaction. Branch reset
notifications publish after commit; rolled-back resets never advance a room.

Thread-peer resolution is primary-Work-aware. After conversation reassignment,
the old peer is no longer resolvable; a pull in the new Work's draft closes it
and seeds a new peer while holding the conversation row lock. Peers are made
only by pulls in an existing draft: a reply's save resolves exactly the peer
each document was pinned to (`InteractionContext.branchId`), under the leases
the pool took before the save's transaction, and refuses that document stale
when the pin no longer holds (closed peer, reset or closed draft branch, closed
draft). Closing a draft closes both kinds of its branches. The fencing lifecycle
(pins, the save's leases, confirmation under its locks) is
`domain/reply-save-fences.ts`; the pool (`domain/thread-peer-core-pool.ts`)
routes and keeps reply records, and `thread-peer-composition.ts` assembles it.

The review list therefore emits one active item per document and folds all
contributing journal rows into that item. `lastActorTurnId` is representative
metadata, not review identity. `draftId` is the only application and wire
identity. `createWorkDraftReviewService()` resolves it to the physical Work
branch and keeps that branch identity inside the domain; `reviewRoomName`
remains an opaque transport address.

Propagation is sync-only. Cold attribution uses persisted branch journal rows
and live journal metadata; memory-only runtime maps are never an attribution
authority.

Review operations keep two internal journal-row identities separate.
`SourceUpdateIds` name the logical source rows used for operation attribution
and presentation; `PhysicalSourceUpdateIds` name every physical row needed to
reconstruct Discard, including reversal rows. Discard classes use the physical
set. Neither identity is wire data, and callers must not substitute one for the
other just because both are represented by numbers at runtime.

Live→Work-draft pulls run after persisted live updates (2-second debounce, 10-second
maximum), on branch review room open/reconnect, and at agent tool boundaries. The
room trigger is fire-and-forget; Hocuspocus admission never waits for the pull. Once
durable, pull deltas use the branch coordinator's existing update publisher so loaded
Hocuspocus branch rooms converge and broadcast normally; unloaded branches remain
persistence-only.

Live checkpoints are a separate cadence from those pulls. They come from four
sources: the initialize-only seed (`up_to_seq = 0`); Hocuspocus
`onStoreDocument` at `debounce: 2000` / `maxDebounce: 10000` plus last-client
disconnect; explicit `CollabDomain.checkpoint`; and `journal.compact`. Compaction
is implemented but has no production caller, so live journal rows are never
deleted.

**Releasing a live room never waits on a database lock.** Closing the last
connection runs `onStoreDocument` inline in the releaser's async context, often
inside its DB transaction. The store therefore only captures the journal cut and
encoded state; the checkpoint write runs after the releaser's transaction
commits, in its own transaction, and is dropped on rollback (the room may hold
that transaction's uncommitted updates) or when the live generation was retired.
Writes queue one per document, newest snapshot wins; shutdown drains them. A
checkpoint only caches durable journal state, so a dropped or late one costs
replay time, never data. Thread-peer pulls also take their live snapshot outside
the caller's transaction, so loading the room cannot leave head or lock rows held
by a caller that then waits on the root pull transaction.

**Branch mutations are durable before they reach a Hocuspocus room.** A draft
branch room is a collaborative room: writer frames from a review editor are
admitted like any other peer's, alongside server-side agent and disposition
commands. No branch-room `onStore` path may re-persist or re-checkpoint to make
a mutation durable — it already is. Live and branch writer frames use the same
sequence: authority/generation validation, exact-containment acknowledgement,
fresh-authorship validation, then durable append. Branch admission runs that
sequence against one locked branch snapshot through the awaited `beforeSync`
hook, before Hocuspocus apply/broadcast/ack. `onChange` does not own branch
persistence. `admitBranchWriterUpdate` registers the whole admission with
`trackAppend` before validation's first `await`, so a `storeHocuspocusBranch` or
graceful-shutdown drain cannot miss an admission Hocuspocus is already
processing — do not move registration after an `await`.
`storeHocuspocusBranch` only drains pending branch admissions; calling
`checkpointBranch` (or any `withBranches`) from it re-enters the publisher's
`AsyncLocalStorage` branch-lock context and throws (`branch-critical-sections.ts`
rejects overlap on sight).

The Yjs route owns only upgrade authentication, CrossWS peer adaptation, and
gateway delegation. `lib/yjs-ws-handler.ts` owns connection state, admission,
Hocuspocus lifecycle hooks, and graceful drain; transport changes must preserve
the admission ordering above and keep `beforeSync` awaited. The gateway is a
synchronous process singleton: authenticated upgrade captures it in the peer
context, and `open`/`message`/`close`/`error` must dispatch through that
instance without a lookup `await`. Startup retains that same instance so
shutdown calls `drain()` before its first await; `drain()` closes admission
synchronously before waiting for persistence.

## Certified provenance materialization

**Ordering invariant:** declaration order in `ir.intent.edits` is not application
order. A `textRanges` edit applies its same-block replacements right-to-left
(`applyInlineReplacements`);
partitioning allocation-ordered strings by iterating declared edits swaps
provenance roots between adjacent targets. The writer instead locates each edit
by its final output span and intersects that span with newly inserted strings.

**Regression trap:** hand-performing Yjs mutations in IR declaration order does
not exercise this seam. Provenance ordering tests must compose the real
`applyEdits`.

For a certified whole-block structural carry, lowering tombstones the input
block before provenance materialization. The writer may locate its output only
through one adjacent visible replacement block whose entire prose belongs to
the current lowering and matches the certified output length. Partial, absent,
or multiple matches fail closed through the length-conservation guard; rendered
text equality is never continuity evidence.

Restoration length is validated independently at both the certification and the
writer boundary; neither check assumes the other ran.

## Pending publication

The `WorkDraftPendingStore` port (Drizzle adapter in `adapters/drizzle-branch-push.ts`)
owns the pending Work-draft predicate used by review lists, counts, and
Auto-apply confirmation: current-generation reviewable rows, one joined query
that projects only `turnId`. Counts are distinct pending documents per Work: the
active draft's branches with reviewable rows plus its change rows (a created
document is pending with no text yet), never raw journal-row totals. The review
list (`domain/draft-review-items.ts`) is the draft's tree state merged with those
branches; Apply is `domain/draft-publication.ts`.

`domain/document-creation.ts` owns tracked-document materialization transactions.
Context and bootstrap supply the row and initial content. They commit together;
warm-room publication follows the enclosing transaction's commit. Tree presence
comes from context's live/draft SQL views, never a Yjs manifest.

## Durable records

- `document_yjs_updates` is the live update journal.
  Writer rows persist as `origin_type = human`; reads also normalize legacy
  `user` rows to the package's `human:<actor>` origin. Reversal and bookkeeping
  rows keep `origin_type = system`, and reversal rows store independent
  `reversal_actor_type` attribution. Agent rows persist as `agent`. A branch
  settlement appends its exact authored rows followed by one `reconcile` row
  carrying the canonical pushed update; the latter supplies replay coverage,
  not a later semantic edit. Only the writer class invalidates a live reversal
  plan.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` stores publication identity, typed branch generation, and
  idempotency lineage. The change trail is the sole durable publication record;
  lineage never duplicates block diffs.

Human-origin edits produce one journal row per keystroke. A 50-character
sentence becomes ~50 rows / ~935 bytes. Journal row counts are not equivalent
to semantic edits. Checkpoint compaction would recover the storage, but it has
no production caller.
Reconnect frames already contained by the live document are acknowledged but
do not enter the journal or trigger post-persistence hooks.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and reports each
removed writer-owned canonical block identity. Missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes;
it does not make the optional mark overlay authoritative.
