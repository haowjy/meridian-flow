# collab — Draft review subsystem

When the effective write mode is `"draft"`, AI agent edits are routed to a
per-work **draft** instead of the live document. Multiple threads in the same Work contribute to the same draft for a document. The live doc is untouched
until the writer accepts. Accept merges draft Yjs deltas into one journal entry
(`writeId=draft-accept:<id>`, origin `system`); reject discards. Both accept
and reject create **synthetic user turns** in the transcript with document
context (name + w-id range) so the LLM sees review lifecycle events.
Accept and reject turns are undoable within 24 hours (see Undo lifecycle below).

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
  `base_live_update_seq` (the live Yjs update sequence the draft branched from) and
  `created_document` (true when this draft came from `write(command="create")`).
  `UNIQUE(documentId, workId)` partial index on `status IN ('active',
  'accepting')` enforces one open draft per (document, Work). `accepting` is
  the fenced accept-in-progress state: it is not listed as an active review
  draft, but it blocks new draft creation and marks the live accept as already
  underway. An expired `accepting` claim can be reclaimed by accept retry; fresh
  concurrent accepts report in-progress.
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
- `UNIQUE(documentId, workId) WHERE status IN ('active', 'accepting')` enforces
  one active/accepting draft per document in a Work
- Per-update attribution mirrors live Yjs updates:
  `document_yjs_draft_updates.actorTurnId` tracks agent/turn rows, and
  `actorUserId` tracks writer rows created through the draft Hocuspocus room.

**Current state of works:** currently 1 work per project, auto-created. No API
to create additional works yet. New work creation is being developed on a
separate branch — expect merge conflicts with the draft re-key migration.

**Domain behavior:**
- Existing thread-scoped routes and write contexts resolve thread → primary Work
  via `thread_works` before draft lookup/creation
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
appending the merged draft update. Reject first records the discard turn, then
deletes the placeholder `documents` row for `created_document` drafts; the FK
cascade removes draft rows and Yjs/draft state so no orphan document remains.

## Accept lifecycle (journal-first, idempotent)

1. **Read-only overlap preflight** — unless the caller confirms an overlap,
   accept rebuilds the draft base from `base_live_update_seq`, diffs stable
   top-level block hashes for base→current-live and base→draft, and returns
   `status: "overlap"` without mutating when the sets intersect. Disjoint edits
   continue silently.
2. **Accept claim closes the draft in DB** — `beginAccept` atomically moves the
   draft from `active` to `accepting` with an internal claim lease. Reject
   atomically moves `active` to `discarded`. This DB state is the fence; the
   in-memory response invalidation is advisory.
3. **Close the draft Hocuspocus room** — reset connected clients after the DB
   fence is in place, then drain pending draft-room persistence. Any keystroke
   racing Apply/Discard reaches `appendUpdate` after the status transition and
   is rejected by the in-transaction active check instead of being swept into
   finalization.
4. **Draft freshness fence** — accept requests carry the writer-reviewed
   `draftRevisionToken` (max `document_yjs_draft_updates.id` from preview).
   After claim + close + drain freezes the row set, accept recomputes the max
   draft update id. A mismatch releases the claim back to `active` and returns
   `status: "stale_draft"` with the current token; the client refetches preview
   and tells the writer, “The draft changed — review the latest changes before
   applying.” It does not auto-retry because the writer must see rows they did
   not review.

Agent draft writes continue while a writer reviews. This is intentional CRDT
behavior: new agent-authored draft updates append to the same draft journal and
stream into the open review surface as additional proposals. The accept
freshness fence above is the consistency boundary: rows the writer did not
review cannot be silently applied because the token changes and accept returns
`stale_draft`, forcing the client to refetch before retrying. Discard uses the
state-vector/revision fenced reject reconstruction for the same reason: concurrent
appends cause refetch-and-retry, not corruption.

5. **Invalidate** in-flight responses for this `(documentId, workId)`.
6. **Merge** all draft deltas via `Y.mergeUpdates`.
6. **Journal-first** persistence: create the user accept turn and append the
   live mutation with `writeId = draft-accept:<id>` stamped to that accept turn;
   unique constraint prevents double-apply on retry. The mutation metadata keeps
   `actorTurnId = draft.lastActorTurnId` only as internal assistant linkage.
8. **Durable status**: `completeAccept` is claim-token fenced inside the store,
   marks the draft `applied`, and cleans draft-scoped agent-edit state.
9. **Side effects** (recoverable): apply/recover the live coordinator projection,
   refresh read models, delete draft-scoped agent-edit state.

Draft response sessions capture the active draft id they read from. Draft-scoped
`appendBatch` revalidates that exact draft id is still `active` inside the DB
transaction before inserting mutations, so a stale response cannot append to a
closed draft or create a replacement draft after accept/reject wins.

Empty drafts (zero updates) auto-discard on accept. Non-empty accepts are
first-class user events appended to the current thread leaf: the accept turn
anchors the live mutation's `turnId`, while `lastActorTurnId` remains internal
lineage to the proposing assistant turn.

## Reject lifecycle

Reject atomically moves the active draft to `discarded`, closes the draft Hocuspocus
room, drains pending draft-room persistence, cleans draft-scoped state inside the
store, then invalidates in-flight responses. Updates never touch live. If the
draft is marked `created_document`, reject deletes the placeholder `documents`
row after writing the reject turn; cascading FKs remove the draft and draft-update
rows.

Reject also creates a synthetic user turn with document context (name + w-id range)
so the LLM sees that a draft was discarded. The reject turn ID is deterministic from
`draft.id` (`createDraftRejectTurnId`), written via `onConflictDoNothing` for idempotency.

## Undo lifecycle

Both accept and reject are undoable within a 24-hour retention window
(`DRAFT_UNDO_RETENTION_MS`). Undo reactivates the draft to `active` status so the
writer can re-review and re-accept or re-discard.

**undoAcceptDraft** (`domain/drafts.ts`):

1. Validate draft exists, is `applied`, and within retention window.
2. **Reactivate first** — claims the draft slot via the unique partial index on
   `(documentId, workId)` for active/accepting drafts. If another active draft
   already exists, returns `conflict` without touching live state.
3. **Reverse the live Yjs mutation** — calls `agentEdit.reverse()` targeting the
   deterministic accept turn. If reversal fails (expired/compacted), the draft is
   safely reactivated and the writer can re-review via preview.
4. Invalidate in-flight responses.

**undoRejectDraft** (`domain/drafts.ts`):

1. Validate draft exists, is `discarded`, and within retention window.
2. Reactivate to `active` — no Yjs reversal needed since reject never touched live.
3. Invalidate in-flight responses.

**Reactivate-first ordering** (fix from review finding, commit `4dee6e4f`):
undo-accept reactivates the draft before reversing Yjs, not after. This eliminates
the race where reversal succeeds but reactivation fails due to a concurrent active
draft — which would leave the live doc undone with no active draft to re-review.
If reversal fails, the draft is already reactivated and the writer can re-review
via preview.

**Wire contract:** `DraftUndoResponse` is narrowed to `{ status: "reactivated" }`
only. Non-success outcomes (`expired`, `conflict`, `not_found`) are HTTP errors
(410/409/404) from the route layer. The client uses typed error codes rather than
parsing response body variants that never arrive on a 200.

## Draft list methods

Two distinct queries serve different consumers:

- **`listActiveDrafts(threadId)`** — resolves the thread's primary Work and returns only active drafts in that Work. Used by the write-mode route guard to block `draft` → `direct` switching while active drafts exist.
- **`listReviewableDrafts(threadId)`** — resolves the thread's primary Work and returns `active` + recently `applied` + recently `discarded` drafts (within 24-hour retention window). Used by the
  client to render draft review cards including terminal-state cards with undo
  buttons. Active drafts sort first within each document group so the actionable
  draft is always `group.drafts[0]`.

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
- `rejectSourceUpdateIds` — connected-component union of physical rows for every
  operation sharing hunks with this operation.
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

Preview contract: `recommendedSurface` is the UI recommendation (`inline` or
`panel`). `inlineModelPresent` says whether the response includes an inline model
(`operations` + `hunks`) even when the recommended surface is the panel.
`fallbackReason` is the exported `DraftReviewFallbackReason` union.

Fallback thresholds live in `domain/draft-review-hunks.ts`:

- `REWRITE_THRESHOLD = 0.6` — >60% changed characters → panel
- `HUNK_DENSITY_LIMIT_PER_1000_CHARS = 15` — >15 hunks per 1000 chars → panel
- `BLOCK_CHURN_THRESHOLD = 0.5` — >50% block type differences → panel
- `SOFT_FALLBACK_TEXT_CHARS_FLOOR = 300` — text-chars denominator is floored at
  300 so tiny documents don't look dense or mostly rewritten by default

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

- **Draft identity = event identity.** Accept/reject turn IDs and the accept
  `writeId` are deterministic from `draft.id`. This conflates "this draft exists"
  with "this review action happened." Re-accept after undo reuses the old turn
  ID, which forces idempotency and lifecycle state to share one key.
  → Introduce separate review event identity per lifecycle action.

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
