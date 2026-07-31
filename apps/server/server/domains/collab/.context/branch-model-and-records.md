# Collab — branch model and durable records

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. There is at most one active Work-draft branch per
`(documentId, workId)`; every thread peer for that document and Work shares it
as upstream. Pushing computes a Yjs update from branch to live, records push
lineage, marks source journal rows reviewed, and resets/advances branch
generation where needed.

Thread-peer resolution is primary-Work-aware. After conversation reassignment,
the old peer is no longer resolvable; provisioning closes it and seeds a new
peer from the new primary Work draft while holding the conversation row lock.

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
order. `applyEdits` sorts same-block Tier-1 edits right-to-left before execution;
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

## Live manifest membership

The project manifest's `documents` Y.Map is the membership authority used by the
live-room gate. Ordinary `resolveManifestMembership` calls never reconcile or
append membership history. `reconcileProjectManifest` is the additive-only, cross-replica-serialized
self-heal command: it seeds missing active database content rows, but never
rewrites an existing key or removes an entry. The WebSocket gate invokes it once
after a membership miss. Manifest write-intent paths do not run this broad SQL
reconciliation; draft-scoped creation (`workId` or `threadId`) must not allow
unstaged document rows to enter live membership. Creation and deletion flow
through `recordManifestDocument{Created,Deleted}`, with SQL
soft-delete committed before the deletion notification. Preserve every no-op guard:
setting an equal Y.Map value still creates Yjs history. See
[KB: Manifest Membership Port](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/manifest-membership-port.md)
for the cross-domain port decision and self-healing rationale.

Manifest membership rows are branch bookkeeping, not writer-reviewable prose.
`domain/work-draft-pending.ts` owns the pending Work-draft predicate used by
review lists, counts, and Auto-apply confirmation: it requires current-generation
reviewable rows loaded through the `WorkDraftPendingStore` seam and excludes
`manifest_membership` rows. Its Drizzle adapter loads all evidence in one joined
query and projects only the classification fields (`turnId` and `updateMeta`);
ordinary counts and lists must not read full Yjs payloads. Counts are reviewable
content branches (one per document), never raw journal-row totals. The authority
still associates an excluded manifest entry with its content draft so confirmed
Auto-apply publishes new-document content and live membership atomically. A
reusable manifest Work-draft branch may remain `active` after its content
companions settle; that status alone is not pending-review evidence.

`domain/document-creation.ts` owns tracked-document materialization
transactions. Context and bootstrap supply the row, initial-content, and
manifest operations; the aggregate commits them together. Repair uses the same
boundary so a row cannot become visible before its Yjs authority is usable.
Initial-content and live-manifest recovery publish to warm Hocuspocus rooms only
after the enclosing Drizzle transaction commits. Work/thread manifest mutations
persist their branch state inside that transaction and defer the automatic live
push until commit.

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
sentence becomes ~50 rows / ~935 bytes. This is expected: checkpoint compaction
recovers storage, and journal row counts are not equivalent to semantic edits.
Reconnect frames already contained by the live document are acknowledged but
do not enter the journal or trigger post-persistence hooks.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and reports each
removed writer-owned canonical block identity. Missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes;
it does not make the optional mark overlay authoritative.
