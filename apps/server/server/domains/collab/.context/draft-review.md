# collab — Draft review subsystem

When the effective write mode is `"draft"`, AI agent edits are routed to a
per-work **draft** instead of the live document. Multiple threads in the same Work contribute to the same draft for a document. The live doc is untouched
until the writer accepts. Accept merges draft Yjs deltas into one journal entry
(`writeId=draft-accept:<id>`, origin `system`); reject discards. Both accept
and reject create **synthetic user turns** in the transcript with document
context (name + w-id range) so the LLM sees review lifecycle events.
Accept and reject turns are undoable within 24 hours (see Undo lifecycle below).

Write mode resolution is **per-thread**, not per-project. Draft scope is **per-work**, not per-thread; the thread still chooses whether writes route to draft or direct mode. The `aiWriteMode`
column on `threads` is seeded from the project preference at thread creation;
the thread-level value is authoritative for all subsequent writes. A
write-mode switch route blocks `draft` → `direct` while active drafts exist
(for the reverse direction, `direct` → `draft` is always permitted). See
[`domains/threads/.context/CONTEXT.md`](../threads/.context/CONTEXT.md).

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
  `base_live_update_seq` (the live Yjs update sequence the draft branched from).
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
  the thread's Work, not only the thread itself
- Draft listing returns the Work's reviewable drafts, so sibling threads see the
  same shared draft

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
4. **Invalidate** in-flight responses for this `(documentId, workId)`.
5. **Merge** all draft deltas via `Y.mergeUpdates`.
6. **Journal-first** persistence: create the user accept turn and append the
   live mutation with `writeId = draft-accept:<id>` stamped to that accept turn;
   unique constraint prevents double-apply on retry. The mutation metadata keeps
   `actorTurnId = draft.lastActorTurnId` only as internal assistant linkage.
7. **Durable status**: `completeAccept` is claim-token fenced inside the store,
   marks the draft `applied`, and cleans draft-scoped agent-edit state.
8. **Side effects** (recoverable): apply/recover the live coordinator projection,
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
store, then invalidates in-flight responses. Updates never touch live.

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

## Known gaps (from review, not yet addressed)

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

## Draft review rearchitecture — TODO

Design: [inline-diff-decoration-architecture.md] in
`meridian-flow-docs/work/human-undo-affordance/design/`.

### Draft Hocuspocus rooms

Each draft gets its own Hocuspocus room (room ID = draft ID). Same
TipTap/Hocuspocus stack handles sync, persistence, undo. The Hocuspocus
server hooks already handle persistence for live docs — draft rooms use the
same hooks, scoped by draft ID. Draft updates persist as
`document_yjs_draft_updates` rows.

Room lifecycle: creation when AI starts writing, availability when writer
enters review, cleanup when draft transitions to applied/discarded.

### Writer edits during review = new draft update rows

During review, the writer edits the draft freely. Their edits persist as
`document_yjs_draft_updates` rows with `actorUserId` and no `actorTurnId`.
Attribution rule:

| Row attribution | Review operation kind |
|---|---|
| `actorTurnId` present | `kind: "agent"` linked to that turn |
| `actorTurnId` null, `actorUserId` present | `kind: "writer"` linked to that user |
| both null | `kind: "agent"` with no turn linkage |

The both-null case is intentionally **not** writer attribution: a deleted AI turn
can be nulled by `ON DELETE SET NULL`, and that prose must not masquerade as the
writer's own edit.

### Reject = reverse Yjs updates on draft

Reject reverses a hunk's contributing updates on the draft Y.Doc (both AI and
writer updates after hunk coalescence). Uses the same cold-reconstruction
pattern as `packages/agent-edit/src/undo/reconstruction.ts`. The reversed
updates are applied with `HUNK_REJECT_ORIGIN` and tracked by UndoManager.

**Journal invariant: active draft update rows are never compacted.** The reject
path depends on immutable, individually addressable ordered update rows.
Compaction is only allowed after draft finalization (apply/discard).

### Apply is whole-draft only (v1)

v1 uses the existing `acceptDraft` server-side path. The writer curates the
draft (rejects unwanted hunks, edits others), then applies the whole result.
Per-hunk apply is deferred — storage granularity (one update row ↔ multiple
hunks) makes region-scoped transfer unreliable without precomputed payloads.

### Concurrency policy during review

v1 simplest option: block AI writes to the draft room during active review.
If the live doc changes during review, Yjs CRDT merge handles most cases on
apply. Large live-doc structural changes dismiss review (fall back to
re-entering review with a fresh hunk model).

[inline-diff-decoration-architecture.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/inline-diff-decoration-architecture.md

## Invariants

- **Live is always canonical.** A draft is proposed changes, not a document.
- **Draft updates are review deltas only.** No seed, no live updates in the draft
  log. Agent rows are attributed by turn; writer rows are attributed by user.
- **Accept is journal-first.** Journal is authoritative; live projection and
  status update are recoverable side effects.
- **Draft finalization invalidates in-flight responses.** Accept or reject
  broadcasts to the response registry.
- **One active/accepting draft per (document, Work).** Partial unique index
  on `status IN ('active', 'accepting')`.
- **Undo reactivates the draft first, then reverses Yjs.** The draft slot is
  claimed before touching live state, so a failed reversal leaves a re-reviewable
  draft rather than a desynchronized live document.
- **Undo retention is 24 hours.** Past the window, undo returns `expired` and
  the client grays out the undo button. The draft row persists for audit.

## Draft preview hunk model (server)

`previewDraft` now returns an inline-review hunk model for active drafts. The
server computes the model against one consistent live/draft snapshot: live at the
current live update seq, draft after replaying the listed draft update rows, and
`draftRevisionToken = max(document_yjs_draft_updates.id)` for those rows.

The computation is split between `domain/draft-review-hunks.ts` (block alignment,
text diffing, anchors, and writer clustering) and `domain/draft-update-attribution.ts`
(Yjs update-row attribution). Hunks are anchored with serialized
`Y.RelativePosition`s in the draft doc and attributed by indexing decoded draft
update structs/delete sets by `{client, clock}` ranges.

Delete attribution is **effective-state based**, not monotonic delete-set based.
The attribution index replays ordered draft update rows from the live base with
`gc: false` and credits a delete range only when that row changes the range from
effectively visible to absent. If a later undo resurrects a range, the older
delete attribution is cleared; if the text is re-deleted, the last delete row owns
the final absence. Yjs undo may restore content as new structs, so the index also
records row-local aliases from an original hidden range to the newly introduced
restored struct and carries attribution back to the original range when the
restored struct is deleted. This preserves two invariants at once: cumulative
Yjs delete sets do not over-attribute plain sequential deletes, and delete → undo
→ re-delete attributes to the row responsible for the final draft state.

Rows with `actorTurnId` are agent operations (`operationId = row id`). Rows with
`actorUserId` are writer-attributed rows; after hunk attribution, writer hunks are
clustered by spatial proximity into synthetic operations (`writer:1`,
`writer:2`, ...):

- hunks in the same top-level block join the same writer operation;
- hunks in adjacent changed blocks join the same writer operation;
- hunks separated by any unchanged block start a new writer operation.

Grouping is view-layer only. Source rows stay fine-grained, and each writer
operation exposes `sourceUpdateIds` as the union of rows contributing to its
hunks.

Fallback recommendation is server-side, but the active surface is
per-review-session. Initial entry uses the server recommendation. A caller that is
already in inline review can request `surface=inline` on preview; the server still
returns `reviewMode: "panel"` plus `fallbackReason` when soft thresholds are
exceeded (rewrite threshold >60% chars changed, hunk density >15 hunks per 1000
chars, or block churn >50% inserted/deleted blocks), but it includes `operations`
and `hunks` so the inline session is not rug-pulled mid-review. Unsupported
changed top-level node types are the hard fallback: even with `surface=inline`,
the server returns panel mode and omits the inline model because the client cannot
render those regions safely.
