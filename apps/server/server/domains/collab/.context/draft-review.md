# collab — Draft review subsystem

When the effective write mode is `"draft"`, AI agent edits are routed to a
per-work **draft** instead of the live document. Multiple threads in the same Work contribute to the same draft for a document. The live doc is untouched
until the writer accepts. Accept merges draft Yjs deltas into one journal entry
(`writeId=draft-accept:<id>:<accept_generation>`, origin `human:<writerUserId>`); reject discards.
Draft apply/discard/undo are work/document lifecycle facts, not conversation
turns: they do not insert transcript rows, advance `activeLeafTurnId`, or add
synthetic user messages. The next model turn receives terse system context for
recent draft lifecycle events in the Work. Accept and reject are undoable within
24 hours (see Undo lifecycle below).

Write mode is **owned by the Work** (`works.ai_write_mode`). Threads and project
preferences do not store or inherit a mode. The response router resolves
`thread -> primary Work -> works.ai_write_mode` at write time, so flipping a Work
applies immediately to existing threads. The Work write-mode route allows
`direct -> draft` anytime and rejects `draft -> direct` while the Work has any
active drafts (`active_drafts`), preserving the invariant: **direct mode implies
no active drafts in that Work**.

The two-system undo model differentiates draft undo from auto-apply undo:
draft undo removes a turn's contribution from the accumulated draft; auto-apply
undo (live-lineage) reverses the Yjs mutation in the live document. See the
[requirements doc](../../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/human-undo-affordance/requirements.md)
for design decisions.


## Review service shape and snapshot invariant

`domain/draft-review-service.ts` is the single draft-review service. It owns the writer-facing review operations as one coherent boundary: preview, immutable journal snapshot reads, overlap checks, full accept, partial accept, reject, undo-accept reactivation, and undo-reject reactivation. `domain/drafts.ts` is now the persistence/type contract; stores implement it, while the service composes the contract with the live journal/coordinator and draft write router. Composition wires the service directly and passes the router's real in-flight session counter; there is no query-service overlay or placeholder counter.

Preview and accept share exactly one review snapshot builder: `buildDraftReviewSnapshot(...)` in `domain/draft-review-snapshot.ts`. This is the invariant boundary between what the writer reviewed and what the server may apply. Any future rule that affects live/draft basis docs, serialized preview markdown, review operations, hunks, fallback state, or revision tokens must be implemented in that builder so preview and accept cannot diverge.

Directional operation identity is explicit inside the domain model: each internal review operation carries `directionalClosure.accept` and `directionalClosure.reject` payloads with operation ids and update ids for that action. The route DTO field names remain unchanged (`rejectSourceUpdateIds`, `acceptClosureOperationIds`, `rejectClosureOperationIds`), but server code should use the directional payloads rather than inferring action semantics from similarly named wire fields.

### Public facade and DTO boundary

`collab/index.ts` exposes role-based draft surfaces, not the draft persistence model:

- `draftReview` is the work/document keyed route-facing API: list, preview, journal, accept, reject, undo-accept, and undo-reject. It resolves the producing thread, active draft row, and claim/reversal details internally.
- `draftLifecycleFeed` exposes only `listLifecycleEventsByWorkSince` for runtime context injection.
- `draftSessionStats` exposes the active/in-flight counts needed by the Work write-mode guard.

Raw `Draft` rows, claim tokens, accept generations, `baseLiveUpdateSeq`, thread-resolution helpers, and active-draft lookups are collab-internal. Routes translate auth/path inputs to the role facade and map results to wire DTOs. Contracts describe the wire, not the model: internal review operations/hunks live under `domain/draft-review-types.ts`; `packages/contracts/src/drafts/` is split into review view-models and reject-runtime artifact DTOs. The only internal → wire mapping for review operations is in `server/lib/draft-review-route.ts`.

## Response session registry

`domain/draft-write-mode-router.ts` is keyed by `responseId`. On first write, resolves the thread's effective
`WriteMode` (`direct` | `draft`), creates the appropriate `AgentEditCore`
(live or draft-scoped), memoizes it. `commitResponse` / `rollbackResponse`
route to the same core.

- **Live session core** = standard `AgentEditCore` over the live journal +
  coordinator.
- **Draft session core** = draft-scoped `AgentEditCore` (`drizzle-draft-agent-edit.ts`)
  that seeds from live + existing draft deltas, persists writes under
  `scope_id = draft ULID`.

Draft finalization (accept or reject) **invalidates in-flight responses** —
the registry marks active cores for every thread in the finalized draft's Work as stale. This is intentionally work-wide: a response in any sibling
thread that has not touched the finalized document yet is still based on a
pre-close review context and must not create a fresh replacement draft. `commitResponse` returns `DraftClosedFinalizeResult`
(`status: "draft_closed"`) instead of flushing writes.

## State isolation via `scope_id`

Agent-edit state tables (`agent_edit_mutations`, `agent_edit_wid_counters`,
`agent_edit_sync_state`, `document_yjs_reversals`) carry a non-null `scope_id`
column. Direct mode uses the sentinel `"live"`; draft mode uses the draft ULID.
`drizzle-agent-edit-scope.ts` exports `scopedWhere` / `scopedValues` helpers
so adapters compose the partition without code duplication.

## Draft persistence tables

- **`document_yjs_drafts`** — one row per draft, including
  `base_live_update_seq` (the live Yjs update sequence the draft branched from),
  `accept_generation` (the lineage number for the next/last Apply attempt), and
  `created_document` (true when this draft came from `write(command="create")`).
  `UNIQUE(documentId, workId)` partial index on `status IN ('active',
  'accepting', 'reactivating')` enforces one open draft per (document, Work).
  `accepting` and `reactivating` are the persisted states of one claimed-mutation
  model. `claimMutation(kind, fromStatuses)` mints a token, moves the row to the
  kind's claimed status (`accepting` for accept, `reactivating` for undo-accept),
  and lets a stale claim be taken over after the shared 10-minute timeout.
  `finishClaimedMutation` and `abortClaimedMutation` are token-gated. Claimed
  states are not listed as active review drafts, block new draft creation, and
  are non-appendable; fresh concurrent claims report in-progress.
- **`document_yjs_draft_updates`** — append-only deltas per draft (no seed, no
  live updates in the log). Agent pipeline rows carry `actorTurnId`; writer
  draft-room rows carry `actorUserId`.

### Work-scoped draft identity

**Decision:** drafts are keyed to `(documentId, workId)`. Multiple threads in the same Work contribute to one shared draft per document.

**Producing thread resolution:** draft read and lifecycle routes are work-keyed.
The producing thread for a draft is resolved server-side from draft provenance:
`resolveDraftThreadId` joins `document_yjs_drafts.lastActorTurnId → turns.id →
turns.threadId`. This avoids passing thread id as a route parameter, which would
be fragile when drafts outlive the thread that created them.

**Schema:**
- `document_yjs_drafts.workId` references `works.id`
- `UNIQUE(documentId, workId) WHERE status IN ('active', 'accepting',
  'reactivating')` enforces one open draft per document in a Work
- Per-update attribution mirrors live Yjs updates:
  `document_yjs_draft_updates.actorTurnId` tracks agent/turn rows, and
  `actorUserId` tracks writer rows created through the draft Hocuspocus room.

**Current state of works:** currently 1 work per project, auto-created. No API
to create additional works yet. New work creation is being developed on a
separate branch — expect merge conflicts with the draft re-key migration.

**Domain behavior:**
- Draft HTTP routes are work-scoped (`/works/:workId/documents/:documentId/draft/*`).
  Mutations validate the draft row's own `workId` + `documentId`; journal calls
  resolve `threadId` from the work's primary thread, not `lastActorTurnId` provenance.
- Thread-scoped write contexts still resolve thread → primary Work via
  `thread_works` before draft lookup/creation
- `drafts.ts` and the Drizzle draft adapters key draft queries by `workId`
- Write-mode guard: "block draft→auto-apply while active drafts exist" checks
  the Work, not only the current thread
- Draft listing returns the Work's reviewable drafts, so sibling threads see the
  same shared draft


### Draft-created document lifecycle

In draft mode, `write(command="create")` creates the context `documents` row as a
placeholder so the draft can be addressed and reviewed, but it defers live Yjs
state: before accept there is no live writable content for that document. When
the response commits, the router marks the active draft `created_document=true`.
Accept follows the normal draft-accept path and materializes the live document by
appending the merged draft update. Reject deletes the placeholder `documents` row
for `created_document` drafts; the FK cascade removes draft rows and Yjs/draft
state so no orphan document remains.

## Accept lifecycle (journal-first, idempotent)

1. **Read-only overlap preflight** — unless the caller confirms an overlap,
   accept rebuilds the draft base from `base_live_update_seq`, diffs stable
   top-level block hashes for base→current-live and base→draft, and returns
   `status: "overlap"` without mutating when the sets intersect. Disjoint edits
   continue silently.
2. **Accept claim closes the draft in DB** — `claimMutation(kind="accept",
   fromStatuses=["active"])` atomically moves the draft to `accepting` with an
   internal token lease. Reject atomically moves `active` to `discarded`. This DB
   state is the fence; the in-memory response invalidation is advisory.
3. **Close the draft Hocuspocus room** — reset connected clients after the DB
   fence is in place, then drain pending draft-room persistence. Any keystroke
   racing Apply/Discard reaches `appendUpdate` after the status transition and
   is rejected by the in-transaction active check instead of being swept into
   finalization.
4. **Draft freshness fence** — accept requests carry the writer-reviewed
   `draftRevisionToken` (max `document_yjs_draft_updates.id` from preview).
   After claim + close + drain freezes the row set, accept recomputes the max
   draft update id. A mismatch aborts the claim back to `active` and returns
   `status: "stale_draft"` with the current token; the client refetches preview
   and tells the writer, “The draft changed — review the latest changes before
   applying.” This strict stale fence is for per-operation accept. Whole-draft
   Apply deliberately refreshes preview at click time and sends that current
   token, so it applies the draft as it stands when the writer clicks Apply
   (last-writer-wins for the writer's own just-typed draft-room edits) instead
   of 409ing on every draft-room tweak.

Agent draft writes continue while a writer reviews. This is intentional CRDT
behavior: new agent-authored draft updates append to the same draft journal and
stream into the open review surface as additional proposals. The accept
freshness fence above is the per-operation consistency boundary: rows the writer
has not reviewed cannot be silently applied through operation accept because the
token changes and accept returns `stale_draft`, forcing the client to refetch
before retrying. Whole-draft Apply is intentionally looser as described above.
Discard uses the
state-vector/revision fenced reject reconstruction for the same reason: concurrent
appends cause refetch-and-retry, not corruption.

5. **Invalidate** in-flight responses for this `(documentId, workId)`.
6. **Merge** all draft deltas via `Y.mergeUpdates`.
7. **Journal-first** persistence: append the live mutation with
   `writeId = draft-accept:<id>:<accept_generation>`,
   `agent_edit_mutations.turn_id = null`, and a live Yjs update attributed to
   `actorUserId = appliedByUserId`. The writer is the actor; there is no
   receipt turn. The unique constraint prevents double-apply on retry within the
   current generation; undo-reactivation increments the generation so re-apply
   can write a new live mutation instead of colliding with a reversed row.
8. **Durable status**: `finishClaimedMutation(targetStatus="applied")` is
   claim-token fenced inside the store, marks the draft `applied`, and cleans
   draft-scoped agent-edit state.
9. **Side effects** (recoverable): apply/recover the live coordinator projection,
   refresh read models, delete draft-scoped agent-edit state.

Draft response sessions capture the active draft id they read from. Draft-scoped
`appendBatch` revalidates that exact draft id is still `active` inside the DB
transaction before inserting mutations, so a stale response cannot append to a
closed draft or create a replacement draft after accept/reject wins.

Empty drafts (zero updates) auto-discard on accept. Non-empty accepts are live
document writes keyed by `draft-accept:<id>:<accept_generation>`;
`lastActorTurnId` remains the provenance anchor for the proposing assistant
turn's draft card, not a lifecycle receipt.

## Reject lifecycle

Reject atomically moves the active draft to `discarded`, closes the draft Hocuspocus
room, drains pending draft-room persistence, cleans draft-scoped state inside the
store, then invalidates in-flight responses. Updates never touch live. If the
draft is marked `created_document`, reject deletes the placeholder `documents`
row after writing the reject turn; cascading FKs remove the draft and draft-update
rows.

Reject does not create a transcript event. It is represented by draft status and
by the producing assistant turn's anchored draft card; future model calls learn
about the discard through draft lifecycle context injection.

## Undo lifecycle

Both accept and reject are undoable within a 24-hour retention window
(`DRAFT_UNDO_RETENTION_MS`). Undo leaves the draft `active` only after every
durable rewrite has landed, so the writer can re-review and re-accept or
re-discard without seeing a half-rebased draft.

**undoAcceptDraft** (`domain/draft-review-service.ts`):

1. Validate draft exists, is `applied` (or a resumable `reactivating` retry), and
   within retention window.
2. **Claim reactivation** — uses the same claimed-mutation primitive as accept,
   with `kind="reactivation"`. Full undo claims `applied -> reactivating`; partial
   undo claims `active -> reactivating`. If another open draft already exists,
   the claim returns `conflict` without touching live state. `reactivating` is
   intentionally non-appendable: Hocuspocus draft rooms do not resolve and both
   writer and agent append paths require `status='active'`.
3. **Reverse the live Yjs mutation(s)** — one domain path,
   `reactivateAfterReversing(writeIds)`, calls `agentEdit.reverse()` for the
   target accept write ids. Full undo passes every accept write id in the current
   generation (full apply plus any partial accepts); partial undo passes the one
   operation write id. A target write already marked reversed counts as progress
   on crash-resume. A `not_reversed` result before any reversal aborts the claim
   back to the caller's restore status (`applied` for full undo, `active` for
   partial undo) and returns an HTTP error; the draft update journal is untouched.
4. **Rebase and publish active atomically** — after reversal lands, rebuild the
   draft content from its previous persisted basis, then replace the draft update
   journal with fresh segmented rows against the post-undo live head and advance
   `base_live_update_seq` to that head in the same transaction that flips
   `reactivating -> active`. The rebase derives both the live Yjs state and the
   saved base seq from the same persisted journal snapshot, not the mutable
   coordinator doc. The old draft rows no longer participate in reconstruction.
   This makes the Hocuspocus draft room, preview, and re-apply paths read the
   same canonical basis after undo. Segmented rebase preserves original row
   actor metadata where the row still produces a visible delta; rows whose
   content is already present in the post-undo live base are skipped.
5. Close the draft Hocuspocus room again so a mounted editor reconnects to the
   rebased basis instead of continuing with stale pre-rebase Yjs state.
6. Invalidate in-flight responses.

**undoRejectDraft** (`domain/drafts.ts`):

1. Validate draft exists, is `discarded`, and within retention window.
2. Reactivate to `active` — no Yjs reversal needed since reject never touched live.
3. Invalidate in-flight responses.

**Crash-safety ordering:** undo-accept exposes only stable states. Before
`reactivating`, the draft is still `applied` and live content is unchanged. In
`reactivating`, appends are fenced by status and undo workers are fenced by the
same claimed-mutation token stored in `claim_token`/`claimed_at`; a fresh
concurrent undo receives an in-progress conflict, while a stale lease can be
reclaimed for crash recovery. Retry can resume the reversal/rebase. If live
reversal fails before any row is reversed, the claim aborts to the operation's
restore status (`applied` for full undo, `active` for partial undo).
The only transition to `active` is the transactional basis rewrite, so a mounted
editor can never append rows that are later silently deleted by the rebase.

**Wire contract:** `DraftUndoResponse` is narrowed to `{ status: "reactivated" }`
only. Non-success outcomes (`expired`, `conflict`, `not_found`) are HTTP errors
(410/409/404) from the route layer. The client uses typed error codes rather than
parsing response body variants that never arrive on a 200.

## Draft list methods

Two distinct queries serve different consumers:

- **`listActiveDrafts(threadId)`** — resolves the thread's primary Work and returns only active drafts in that Work. Used by the write-mode route guard to block `draft` → `direct` switching while active drafts exist.
- **`listReviewableDrafts(threadId)`** — resolves the thread's primary Work and returns `active` + recently `applied` + recently `discarded` drafts (within 24-hour retention window). Used by the
  client to render document/editor review state and anchored assistant-turn draft
  cards. Active drafts sort first within each document group so the actionable
  draft is always `group.drafts[0]`. The composer dock filters this broader list
  back to active drafts only; terminal undo belongs to the document entry banner
  and producing assistant turn's card, not stacked dock history.

The split is intentional: `listActiveDrafts` is a narrow invariant guard;
`listReviewableDrafts` is a broader UI query.

## Inline review operation graph

`domain/draft-review-operations.ts` is the single server authority for draft
operation attribution. It replays ordered draft update rows against the live base,
groups writer rows for display, assigns stable operation ids, and computes reject
closures from the hunk graph.

Operation row vocabulary:

- `sourceUpdateIds` — logical rows displayed as the operation's authoring source.
- physical rows — source rows plus restorative/delete rows that currently carry
  or reverse that logical operation during replay; these are internal only.
- `rejectClosureOperationIds` — wire-visible connected-component operation ids
  for per-card discard confirmation. If this list exceeds the selected card, the
  client must confirm and list the neighboring proposals that will disappear.
- `rejectSourceUpdateIds` — connected-component union of physical rows for every
  operation in `rejectClosureOperationIds`.
- `classification` — server-computed enum for card grouping/copy:
  `rename` when the same non-empty before→after pair appears in two or more of
  the operation's hunks; otherwise shape fallback to `addition`, `removal`, or
  `rewrite`. Display strings stay client-owned.
- `beforeExcerpt` / `afterExcerpt` — operation-owned, word-boundary-truncated
  excerpts (≈60 chars) from the first/dominant hunk pair.
- `ReviewHunk.spans` — ordered inserted-text sub-spans with relative-position
  anchors and operation ids, remapped through writer grouping. Deletions remain
  widget-level via `deletedText`.

Invariant: reconstructing an undo of `rejectSourceUpdateIds` returns every
affected region in that connected component to the live-base state. This matters
for coalesced hunks where AI and writer rows visually share one replacement;
discarding only the selected logical row can leave a partial CRDT merge instead
of the live text.

Span invariant: within each hunk, `spans` are non-overlapping and ordered, and
their union equals the hunk's inserted ranges. Every inserted character is
attributed to exactly one response operation id; deleted characters are not
represented as spans.

Agent operation ids remain draft update row ids. Writer operation ids are stable
content-derived ids (`writer:<minRowId>-<hash(sorted sourceUpdateIds)>`), not
display ordinals, so refetches do not renumber client active/pending state.
Clients must use `operation.kind` for behavior, never parse the id prefix.

## Draft projection (`domain/draft-projection.ts`)

All consumers reconstruct draft Yjs state through named projections only — never
assemble base live bytes + draft rows by hand.

| Projection | Basis | Callers |
|---|---|---|
| `buildStoredDraftProjection` | Journal at `baseLiveUpdateSeq` + draft rows | Hocuspocus draft room load |
| `buildReviewDraftProjection` / `buildReviewBasisDocs` | Journal at current live head + draft rows | Preview, accept overlap, review model |
| `buildDraftJournalSnapshot` | Stored base + draft rows as journal snapshot | Draft journal fetch |

Server-local `DraftReviewOperationInternal` carries `sourceUpdateIds` /
`acceptSourceUpdateIds` for closure math; wire `ReviewOperation` strips those fields
but keeps `acceptClosureOperationIds`, `rejectClosureOperationIds`, and
`rejectSourceUpdateIds` because the client needs the same server closure for
confirmation copy and exact reject replay.

Preview contract: `inlineModelPresent` is true when the response includes
`operations` + `hunks`. The client chooses inline vs panel from that flag alone
(panel when `inlineModelPresent` is false, e.g. unsupported node types).

## Persistent review cards (client)

After accept or discard, the draft review card does not vanish — it shows a
terminal state:

| Status | Card text | Action |
|---|---|---|
| `active` | Review buttons (Accept / Discard) | Accept, Discard |
| `applied` | "Applied to chapter" | Undo accept |
| `discarded` | "Discarded" | Undo discard |

Both terminal-state cards render an undo button. Undo is disabled (gray) when
past the 24-hour retention window. Undo now lives in the draft card's
`reversible` state and the `DraftReviewBar` — two UI presentations of one
server-backed fact. The old `DraftUndoFooter` was deleted in PR #125; the
client-side `useState` + HTTP-string-matching expiry it used was stale on
reload. Expiry is now precomputed via `isDraftUndoable(draft)` from
`updatedAt + DRAFT_UNDO_RETENTION_MS`.


## Live compaction precondition

Before enabling any production caller of `journal.compact` for live documents, compaction must be fenced by active draft bases: the live compaction floor must not pass `min(document_yjs_drafts.baseLiveUpdateSeq)` for active/accepting drafts on that document. Draft projection, overlap preflight, and draft journal-fetch reconstruct from the draft's base live sequence; compacting past that base would remove the history those reads need. This invariant is documented only — `journal.compact` currently has no production caller and the floor guard remains unimplemented until live compaction is enabled.

## Known gaps (from review, not yet addressed)

- **GitHub issue #126** — Writing agent misapplies precise edits; tool-call
  JSON repair handles syntax but semantic misapplication (edit landing on wrong
  range) requires further investigation. Tracked at the agent-edit pipeline
  level; visible through draft review as unexpected hunk shapes.

- **Four sibling lifecycle flows** (`acceptDraft`, `rejectDraft`,
  `undoAcceptDraft`, `undoRejectDraft`) could collapse to one
  `transitionDraft()` boundary with action + state validation.

- **Collab draft service trending toward god-service.** Query, lifecycle
  mutation, and transcript-turn concerns are mixed in one surface. Split into
  `drafts.query`, `drafts.lifecycle`, and a dedicated journal/audit port for
  transcript event creation.

- **DB DraftStore conformance is local-only.** The shared DraftStore contract is
  exercised by the in-memory store in ordinary test runs and by the Drizzle
  adapter only when `RUN_DB_TESTS=1` and `DATABASE_URL` are set. That database
  conformance is not currently merge protection; deciding whether to provision
  Postgres in CI is an infra/human decision, not part of the test cleanup pass.

### Partial per-operation accept

Inline review can now accept a subset of draft operations while the draft remains
`active`. The accept route accepts optional `operationIds`; the server drains
pending draft persistence, validates the caller's `draftRevisionToken`,
recomputes the current review model, derives the hunk-sharing closure
server-side, and merges only the closure's `acceptSourceUpdateIds` into the live
journal. Partial accept itself does not change the draft update rows,
`baseLiveUpdateSeq`, draft status, or draft room.

Partial accept has two closure graphs. The hunk-sharing graph is a review UX graph: operations sharing rendered hunks drag together so accepting one does not leave a half-overlapped visual edit. The Yjs causal graph is a data-integrity graph: an update row also drags earlier draft rows that supply structs referenced by its item origins or delete sets, even when those rows do not share text hunks. If the dragged causal row maps to a surviving review operation, that operation is included in the same closure confirmation; rows with no surviving operation are merged silently as dependency carriers. As a hard invariant, the server compares the encoded live document content (`Y.encodeStateAsUpdate` — state vectors are blind to delete-only updates) before and after applying a partial-accept update; if the update has no effect, it records no accept mutation and returns `causal_dependency` so the client can tell the writer to accept the earlier proposal or apply the full draft instead of claiming success.

When the server-derived accept closure (hunk-sharing plus causal) is larger than the writer's requested operation ids, accept returns `closure_confirmation_required` listing the full closure. A follow-up accept carries the exact `confirmedClosureOperationIds` plus the preview `liveRevisionToken`; the server proceeds only when both match its recomputed closure at that live revision. If live moved and the closure changes, the server returns a fresh `closure_confirmation_required` instead of applying a larger closure under a stale confirmation. The review model also exposes per-operation `acceptClosureOperationIds` so the client can prompt before calling accept. The server never applies more than the writer confirmed.

Undo-accept verifies each live reversal against the encoded Yjs document state before rebasing, not the state vector. Delete-only inverse updates tombstone existing structs and can restore visible content while leaving the state vector unchanged; those reversals are effective and must proceed to rebase/projection refresh. Genuinely empty inverses are still rejected by agent-edit before this draft lifecycle path treats the reversal as successful. Failed reversal or empty-journal rebase cancels reactivation (`active` for partial undo, `applied` for full undo) and returns conflict. Partial-undo crash resume treats an already-reversed accept mutation as progress when the draft is `reactivating`. Reactivation rebase validates segmented replay against full intent replayed over post-undo live, not equality with stale pre-undo markdown.

Lifecycle `undone` facts use `document_yjs_drafts.undone_at` (set once on reactivation publish, cleared on apply/reject) instead of `updatedAt`, so later draft appends do not re-inject "writer just undid" context.

Partial accept write ids share the full-accept generation lineage:

- full apply: `draft-accept:<draftId>:<accept_generation>`
- partial apply: `draft-accept:<draftId>:<accept_generation>:op:<operationIdSetHash>`

The operation hash is computed from the sorted server-derived closure operation
ids. The active mutation row remains the undo handle returned to the client.
Undoing that handle calls the same `reactivateAfterReversing(writeIds)` path as
full undo, but starts from `active`: claim `active -> reactivating`, reverse that
one live mutation, rebuild the full draft content from the old base plus draft
rows, replace the
draft journal with a fresh delta against the post-undo live head, increment
`accept_generation`, publish `reactivating -> active`, and close the draft room
so mounted editors reload. This is required because the accepted operation's
original Yjs item IDs were already merged into live; the undo reversal tombstones
those items, and replaying the old draft rows over post-undo live is a permanent
Yjs no-op. Fresh rebased rows get fresh item IDs, so the undone operation returns
to preview and can be accepted again with a new write id. Rebase is segmented by
original draft row and carries each row's actor metadata forward, so the review
reconstructs distinct AI vs writer proposal cards after undo. Other partial
accepts that were not undone remain in live and therefore stay out of review
because the rebase treats their content as base.

Full apply undo must reverse every active accept mutation in the draft's current
generation before rebasing the reactivated draft: the full apply write id and all
partial write ids with the generation `:op:` prefix. Reversing partial accepts
after the rebase would bake their content into the new live base, making the
reactivated draft lose those proposals.

When all operations have already been partially accepted, Apply all closes the
draft as `applied` with the latest partial accept seq instead of appending an
empty/no-op live update.
