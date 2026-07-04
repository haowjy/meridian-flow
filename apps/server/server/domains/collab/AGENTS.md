# domains/collab — server-side agent-edit composition

This domain composes the extracted `@meridian/agent-edit` core with Meridian
server persistence and Hocuspocus transport. `createCollabDomain` returns the
server `CollabDomain`: a thin application-facing surface over the package core,
the update journal, the live-document coordinator, and the **draft review
subsystem** (per-work AI drafts routed to a Yjs-delta draft log instead of
the live document).

Drafts go through a full lifecycle: active → accepting → applied | discarded;
undo-accept uses a non-appendable `reactivating` fence before returning to
active. Both accept and discard are **undoable within 24 hours** as
document/work lifecycle facts, not transcript turns. Undo reactivates the draft
for re-review by preserving the original draft rows and using a tombstone-free
review basis.

## What lives here

- **Domain types** (`index.ts`) — `CollabDomain`, update origins, checkpoint
  metadata, write results, Hocuspocus persistence metrics, `WriteMode`
  (`direct` | `draft`), `DraftClosedFinalizeResult`, and the role-based draft
  surfaces (`draftReview`, `draftLifecycleFeed`, `draftSessionStats`).
- **Draft persistence contract** (`domain/drafts.ts`) — draft row/update types,
  `DraftStore`, claimed-mutation inputs/results, and accept-journal contracts.
  Stores own persistence operations (`claimMutation`/`finishClaimedMutation`/
  `abortClaimedMutation`, `reject`/`reactivate`/`recoverAccepted`) that hide
  claim-token fencing.
- **Draft review service** (`domain/draft-review-service.ts`) — the internal
  writer-review boundary behind the public `draftReview` facade: preview, immutable journal snapshot, overlap checks,
  full/partial accept, reject, undo-accept reactivation, and undo-reject. It
  composes `domain/draft-review-snapshot.ts`, the single canonical review
  snapshot builder. Preview and accept must both use that builder so “what the
  writer reviewed” and “what the server applies” cannot drift. Projection bases
  live in `domain/draft-projection.ts`; reactivated drafts preserve original rows
  and use a tombstone-free review basis. Accept/reject do not create transcript
  turns; lifecycle context is injected into later model calls.
- **Draft-scoped agent-edit adapters** (`adapters/drizzle-draft-agent-edit.ts`) —
  per-draft journal/sync-state/lifecycle adapters that resolve a thread to its primary Work, then persist response writes under `scope_id` without touching live Yjs state.
- **Scope sentinel** (`adapters/drizzle-agent-edit-scope.ts`) — `LIVE_SCOPE = 'live'`
  vs draft-ULID `scope_id`, plus composable `scopedWhere`/`scopedValues` helpers.
- **Composition** (`composition.ts`) — builds the codec/model, translates
  Meridian origins to journal meta, wires the markdown-document engine, handles
  checkpoint / restore, Hocuspocus hooks, in-memory/prod factory wiring, and
  the draft-service lifecycle (accept/reject/undo with claim-token fencing
  and reversal port injection).
- **Draft write-mode routing** (`domain/draft-write-mode-router.ts`) — owns
  work-scoped write-mode resolution, response-scoped live-vs-draft core routing,
  stale response invalidation, and response finalization for draft sessions.
- **Full-document markdown engine** (`domain/markdown-document.ts`) —
  server-side read/SET/edit orchestration over the package codec/model, journal,
  and coordinator. This is not part of the `@meridian/agent-edit` public mutation
  surface.
- **Agent-edit adapters** — `drizzle-journal.ts` (`UpdateJournal`,
  mutation metadata queries, server lifecycle, checkpoints, latest attribution),
  plus the user undo-notification adapter that resolves document ids to context
  URIs before recording pending LLM notifications,
  `hocuspocus-coordinator.ts` (`DocumentCoordinator`),
  `document-loader.ts` (journal → Yjs state), and `in-memory/agent-edit.ts`
  (test/app fakes).
- **Server-side helpers** — `domain/document-activity.ts` holds DB helpers for the
  post-write activity/projection hook; `domain/turn-live-lineage.ts` exposes the
  server-owned read-model for live documents keyed by `(threadId, turnId)`;
  `domain/turn-reversal.ts` orchestrates reversal across every document a turn
  touched and feeds the `reverseTurn` facade. These are server read-model side
  effects and turn-level orchestration, not agent-edit package concerns.

## Rules

- Keep package imports one-way: server adapters import `@meridian/agent-edit`;
  the package must not import server code.
- Origin translation belongs in the composition layer. Collab `user` and `import`
  origins persist as package `human:<userId>` meta; missing-user imports map to
  `system`.
- Hocuspocus connection updates append directly to the journal and are tracked
  for drain/metrics; the coordinator is for exclusive live-doc access, not WS
  lifecycle persistence. These connection-update appends do not fire the
  document-level activity/projection hook.
- `readAsMarkdown` reads the coordinator-owned live/persisted Y.Doc and serializes
  through the package codec/model. Context/storage projections are caches for
  listing and search, not a second live-document owner.
- Stale-schema reads fail loud and head stamping is monotonic; rebuild recovery
  is not built. Keep that lifecycle invariant in [`.context/CONTEXT.md`](.context/CONTEXT.md).
- **Undo-accept is fenced.** The draft slot is claimed as non-appendable
  `reactivating` before touching live state, and `active` is restored only by
  the reactivation finalization transaction. See [`.context/draft-review.md`](.context/draft-review.md)
  for the crash-safety ordering.
- **DraftUndoResponse is success-only.** Non-success outcomes are HTTP errors.
  The client does not parse error bodies for business logic.
- **Contracts describe the wire, not the model.** Draft review operations/hunks are
  collab-internal until `server/lib/draft-review-route.ts` maps them to
  `@meridian/contracts/drafts` DTOs.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`.context/draft-review.md`](.context/draft-review.md) — full draft subsystem contracts
→ [Requirements: Undo & Draft Review UX](../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/human-undo-affordance/requirements.md)
→ [Draft Review Lifecycle KB decision](../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/draft-review-lifecycle.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
