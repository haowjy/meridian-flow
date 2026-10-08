# Collab — branch model and durable records

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. There is at most one active Work-draft branch per
`(documentId, workId)`; every thread peer for that document and Work shares it
as upstream. Pushing computes a Yjs update from branch to live, records push
lineage, marks source journal rows reviewed, and resets/advances branch
generation where needed.

Work draft capture, redo, Apply and Discard require an active Work under the
shared lifecycle row lock before durable mutation, and take the row through
`lockSeamWorks` so bound edit grants are confirmed first
([file policy](../../file-policy/.context/CONTEXT.md)). An archived Work's
drafts are frozen: captured evidence stays, and nothing writes, applies or
discards them until unarchive. Replaying
an already committed push returns its durable receipt without reauthorizing a
new write. Draft-only Discard removes only that document’s manifest entry and
resets its content branch in one Work-locked transaction. Branch reset
notifications publish after commit; rolled-back resets never advance a room.

A durable thread peer has no unpublished authored state: reply finalization saves
its edits into the shared Work draft atomically. Before a new call, a pull tests
whether the parent contains the peer's full update, including deletes. If review
retired peer effects, the coordinator resets that peer to the parent instead of
merging stale structs or tombstones back in. Fresh drafted calls also evict the
previous reply's runtime replica before rebuilding from the pulled peer. Calls
already holding a staged document keep that response's private edits.

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
replay or reverse a review class, including invisible suppliers and reversal rows.
`closureUpdateIds` is the shared physical set for per-change Apply and Discard.
Classes union visible hunks, shared physical rows, Yjs origin/rightOrigin/parent
references, delete-set overlaps, and same-client clock-prefix edges. Even unrelated
visible edits can be inseparable when one Yjs client supplied both. Draft review
editors rotate the writer client before an edit in a different closure class or
a disjoint untouched location. Continuous typing and edits within one class
keep their client; a pause alone never rotates. Writer room admissions retain
transaction deltas, not state-vector diffs (which echo cumulative deletions).
Rotation does not remove genuine structural dependencies or split retained rows. Neither identity is wire data, and callers must not substitute one for the
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
[KB: Manifest Membership Port](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/manifest/manifest-membership-port.md)
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
persist their branch state inside that transaction; they never push live (D59).

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

### Preview interleave semantics

`mergeArtifact` identifies surviving insertion structs whose Yjs origin and
right-origin both lie in context deleted by the other author. Ordinary writer
insertions inside intact AI prose keep their author-specific spans, even with
multiple writer runs. A diff hunk can be writer-only while its deleted origin
belongs to an adjacent AI rewrite. Run alternation is not the authority.

Text hunks with `deletedText` also emit `deletedSpans`: ordered, disjoint UTF-16
`from`/`to` offsets covering the full removed string, each with `deletedBy`
(`agent` or `writer`). Authors come from deletion attribution, not inserted
spans or the hunk's owning operations. A single semantic deletion can contain
both authors. This field carries no journal row identifiers. Block-display
hunks keep their existing contract. Cumulative delete-set visibility is checked
per Yjs struct, so old tombstones cannot hide a newly deleted neighboring region.

### Writer Undo restoration attribution

Browser Undo/Redo still allocates fresh writer clocks. Draft editors capture
local `Item.redone` links before Yjs cleanup merges structs and append claims
to `meridian_restoration_claims`, outside manuscript and Undo scope. The outer
Yjs update encodes the current store from its before-state, so it carries both
the text copies and the queued claim transaction. A following map-only frame
is already contained. Claims travel through IndexedDB, local peers and offline
full-state reconnect exactly like other Yjs structs; there is no stateless queue.

The map is untrusted, never attribution authority. `writer-restoration.ts`
certifies only novel claims and targets, retained deleted sources, matching
content and length, and a target anchored at the exact source ID. Restored
containers require certified parent-copy chains and matching source sibling
slots; cross-parent text equality is never sufficient. A stale, displaced, mismatched or
already-admitted claim grants nothing; its bytes are admitted as writer text.
Branch admission persists certified `restorationAliases` in existing journal
`update_meta` under the same snapshot/CAS lock. Contained updates never append
again. Source authorship follows aliases transitively during cold journal replay;
partial restores split target ranges at alias and source-operation boundaries
so each stroke retains its owner. Reconnect frames assign only novel clocks;
repeated source structs cannot overwrite earlier ownership. Physical
writer rows still supply replay/closure, and the browser never uses AI clients.

Writer rows do not invoke the older content-only restorative heuristic. Rendered
text equality without a source-ID anchor cannot preserve AI authorship.
