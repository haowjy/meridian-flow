---
detail: standard
audience: developer
---
# Cleanup Checklist

Everything that must be removed, renamed, or restructured when v2 is complete. Use this as a verification checklist -- if any of these still exist in their old form, cleanup is incomplete.

## Database

### Tables to Remove

| Table | Replacement |
|---|---|
| `collab_document_snapshots` | `document_bookmarks` + `document_checkpoints` |
| `collab_request_idempotency` | Nothing (no server-side accept/reject idempotency needed) |


Auto-accept state is not a separate table. It lives on the `projects` table and user preferences:

| Artifact | Location | Action |
|---|---|---|
| `projects.auto_accept_proposals` column | `migrations/00021_collab_auto_accept_projects.sql` | Remove column (auto-accept is frontend-driven) |
| User preference `collab.auto_accept_proposals` | `user_preferences.preferences` JSONB | Stop reading; frontend owns mode |
| `auto_accept_store.go` | `repository/postgres/collab/` | Remove entirely |
| `AutoAcceptPolicyStore` interface | `domain/services/collab/collab.go` | Remove |
| `AutoAcceptPolicyInputs` type | `domain/services/collab/collab.go` | Remove |

### Columns to Remove from `documents`

| Column | Replacement |
|---|---|
| `yjs_state BYTEA` | `document_updates` + `document_checkpoints` |
| `ai_content TEXT` | Ephemeral projection (computed on demand, never stored) |

### Proposal Table Restructure

Current table: `collab_document_edit_proposals`

Target table: `proposals` (or keep prefixed name per convention)

| Change | Detail |
|---|---|
| Rename status `proposed` -> `pending` | Align with spec terminology |
| Add statuses `stale`, `reverted`, `invalid` | Extend CHECK constraint |
| Add `region_text_before TEXT` | For thread undo (offset-anchored search) |
| Add `region_text_after TEXT` | For thread undo/reapply |
| Add `proposed_at_offset INT` | Set by backend at creation |
| Add `accepted_at_offset INT` | Set by frontend after accept |
| Remove `decided_by_user_id UUID` | Decision authority is Yjs, not backend |
| Remove `decided_at TIMESTAMPTZ` | Same rationale |
| Remove `proposal_group_id UUID` | Grouped hunks are ephemeral |
| Evaluate: `source`, `producer_agent_type`, `agent_run_id`, `description` | May keep for analytics; not required by v2 model |

### Migrations to Write

| Migration | Phase |
|---|---|
| Add `document_updates`, `document_checkpoints`, `document_bookmarks` tables | Phase 0 |
| Add new proposal columns (`region_text_*`, `*_at_offset`) | Phase 1 |
| Rename `proposed` -> `pending`, extend status CHECK | Phase 1 |
| Remove `ai_content` from documents | Phase 1 |
| Remove `yjs_state` from documents | Phase 0 (after append-only is live) |
| Drop `collab_document_snapshots` | Phase 0 (after bookmarks are live) |
| Drop `collab_request_idempotency` | Phase 2+ (after accept/reject moves to frontend) |
| Remove `projects.auto_accept_proposals` column + user pref reads | Phase 3 (after auto-apply moves to frontend) |
| Remove `decided_by_user_id`, `decided_at` from proposals | Phase 4+ (after status mirror is live) |
| Evaluate `proposal_group_id` removal | Phase 2 (after grouped hunks are ephemeral) |

## Backend Code

### Files to Remove or Gut

| File | Action | Reason |
|---|---|---|
| `service/collab/ai_content_projector.go` | Gut and rename to `projected_state_builder.go`: remove `Recompute()` and all `ai_content` column writes, keep `BuildProjectedState()` | `ai_content` column is gone; projection-for-AI-context stays. `ProjectedStateBuilder` interface survives — used by mutation strategy (`CollabProposalStrategy`) and LLM streaming service for AI document reads. |
| `service/collab/ai_content_projector_test.go` | Update and rename to `projected_state_builder_test.go` | Match gutted implementation |
| `repository/postgres/collab/auto_accept_store.go` | Remove entirely | Auto-accept is frontend-driven |
| `handler/collab_snapshot.go` | Remove entirely | Replaced by bookmark API |
| `handler/collab_snapshot_test.go` | Remove entirely | |

### Interfaces to Remove

| Interface | File | Reason |
|---|---|---|
| `AIContentProjector` (the `Recompute` part) | `domain/services/collab/collab.go` | No persisted projection |
| `AIContentReader` | `domain/services/collab/collab.go` | No `ai_content` column |
| `AutoAcceptPolicyStore` | `domain/services/collab/collab.go` | Frontend-driven |
| `AgentArbiter` | `domain/services/collab/collab.go` | Frontend-driven |
| `ArbiterStrategy` | `domain/services/collab/collab.go` | Frontend-driven |
| `IdempotencyStore` | `domain/services/collab/collab.go` | No server-side accept/reject |

### Interfaces to Modify

| Interface | File | Change |
|---|---|---|
| `ProposalService` | `domain/services/collab/collab.go` | Remove `AcceptProposal`, `RejectProposal`, `GroupAccept` |
| `ProposalStore` | `domain/services/collab/collab.go` | Remove `MarkAccepted`, `MarkRejected`; add status mirror upsert |
| `DocumentStateStore` | `domain/services/collab/collab.go` | Replace with `UpdateLogStore` (append-only) |
| `SnapshotStore` | `domain/services/collab/collab.go` | Replace with `BookmarkStore` |

### Types to Remove

| Type | File | Reason |
|---|---|---|
| `AcceptProposalRequest` | `domain/services/collab/collab.go` | No server-side accept |
| `AcceptProposalResult` | `domain/services/collab/collab.go` | |
| `RejectProposalRequest` | `domain/services/collab/collab.go` | No server-side reject |
| `RejectProposalResult` | `domain/services/collab/collab.go` | |
| `GroupAcceptRequest` | `domain/services/collab/collab.go` | No server-side group accept |
| `GroupAcceptResult` | `domain/services/collab/collab.go` | |
| `ProposalMutationIntent` | `domain/services/collab/collab.go` | No broadcast intents from accept/reject |
| `ArbiterInput` | `domain/services/collab/collab.go` | |
| `ArbiterDecision` | `domain/services/collab/collab.go` | |
| `ArbiterVerdict` | `domain/services/collab/collab.go` | |
| `AutoAcceptPolicyInputs` | `domain/services/collab/collab.go` | |
| `ProposalDecision` | `domain/models/collab/proposal.go` | No `decided_by`/`decided_at` |
| `IdempotencyRecord` | `domain/models/collab/` | |

### Handler Code to Remove

| Code | File | Reason |
|---|---|---|
| `handleProposalAccept()` | `handler/collab_proposal.go` | Local-first |
| `handleProposalReject()` | `handler/collab_proposal.go` | Local-first |
| `handleProposalGroupAccept()` | `handler/collab_proposal.go` | Local-first |
| `handleProposalRequestUpdate()` | `handler/collab_proposal.go` | Replaced by REST |
| `broadcastProposalMutations()` | `handler/collab_proposal.go` | No server-side mutation intents |
| `sendProposalSnapshot()` | `handler/collab_proposal.go` | Replaced by REST |
| All `proposal:accept/reject/groupAccept` WS routing | `handler/collab_project.go` | |
| All idempotency helper functions | `handler/collab_proposal.go` | `buildCanonicalRequestHash`, etc. |

### Service Code to Remove

| Code | File | Reason |
|---|---|---|
| `AcceptProposal()` | `service/collab/proposal_service.go` | Local-first |
| `RejectProposal()` | `service/collab/proposal_service.go` | Local-first |
| `GroupAccept()` | `service/collab/proposal_service.go` | Local-first |
| All arbiter chain code | `service/collab/` | Frontend-driven |
| `Recompute()` on `AIContentProjector` | `service/collab/ai_content_projector.go` | No persisted projection |

### Repository Code to Remove

| Code | File | Reason |
|---|---|---|
| `MarkAccepted()` | `repository/postgres/collab/proposal_store.go` | Status comes from Y.Map mirror |
| `MarkRejected()` | `repository/postgres/collab/proposal_store.go` | |
| `getCurrentStatus()` | `repository/postgres/collab/proposal_store.go` | |
| `markTerminalStatus()` | `repository/postgres/collab/proposal_store.go` | |
| All `idempotency_store.go` | `repository/postgres/collab/` | |
| All `auto_accept_store.go` | `repository/postgres/collab/` | |
| All snapshot queries in `document_store.go` | `repository/postgres/collab/` | |

### Mutation Strategy Changes

| Code | File | Change |
|---|---|---|
| `CollabProposalStrategy.Apply()` | `tools/mutation_strategy_collab.go` | Add `region_text_before`, `region_text_after`, `proposed_at_offset` to `CreateProposalRequest`. Remove auto-accept broadcasting (status is always `pending` at creation). |
| `MutationInput` | `tools/mutation_strategy.go` | May need `OldContent`/`ReplContent` exposed for `region_text_*` |

### Session Manager Changes

| Code | File | Change |
|---|---|---|
| `persist()` / debounced save | `service/collab/session_manager.go` | Replace overwrite with `AppendUpdate()` row insert |
| `loadState()` | `service/collab/session_manager.go` | Replace `LoadState()` with checkpoint + replay |
| Snapshot-on-N-updates | `service/collab/session_manager.go` | Remove (replaced by compaction worker) |

### `main.go` Dependency Wiring Changes

| Current | Change |
|---|---|
| `autoAcceptStore := postgresCollab.NewAutoAcceptStore(...)` | Remove |
| `idempotencyStore := postgresCollab.NewIdempotencyStore(...)` | Remove |
| `aiContentProjector := serviceCollab.NewAIContentProjector(...)` | Keep but simplify (no `Recompute`) |
| `agentArbiter := serviceCollab.NewStrategyChainArbiter(...)` | Remove |
| `collabSnapshotHandler := handler.NewCollabSnapshotHandler(...)` | Remove |
| `collabCleanup := jobs.NewCollabCleanup(...)` | Replace with compaction worker |
| Snapshot REST route registrations | Remove |
| `proposalService` constructor args (idempotency, autoAccept, arbiter, projector) | Simplify |

## Frontend Code

### Current Code to Remove (exists in production frontend)

| Code | Reason |
|---|---|
| WS `proposal:accept` / `proposal:reject` / `proposal:groupAccept` command sending | Replaced by local Yjs transactions |
| WS `proposal:snapshot` handling | Replaced by REST on connect |
| WS `proposal:statusChanged` handling | Status flows through Yjs sync |
| WS `proposal:requestUpdate` / `proposal:updateData` handling | Replaced by REST |
| Any `ai_content` reads from document API | Column removed |

### New Frontend Code (v2)

| Component | Purpose |
|---|---|
| Projection pipeline (`derive()`) | Clone + apply + diff + group + decorate |
| Hunk action transactions | Accept/reject with `ORIGIN_ACCEPT`/`ORIGIN_REJECT` |
| UndoManager setup | Unified over Y.Text + Y.Map, tracked origins |
| Thread undo/reapply | Offset-anchored search, `ORIGIN_THREAD` |
| Projection GC | Text pre-check + empty attribution, `ORIGIN_GC` |
| Auto-apply handler | `proposal:new` listener, Y.Map guard, `ORIGIN_ACCEPT` |
| Re-derive triggers | Proposal events, debounced typing, remote changes |
| `accepted_at_offset` API call | After accept transaction |

## Documentation to Update

| Doc | Change |
|---|---|
| `_docs/technical/collab/yjs-state-lifecycle.md` | Update for append-only model |
| `_docs/technical/collab/ai-content-projection.md` | Update or remove (projection is ephemeral) |
| `_docs/technical/collab/ai-edit-flow.md` | Update for v2 proposal creation |
| `_docs/technical/collab/human-editing-flow.md` | Update for local-first accept/reject |
| `_docs/technical/backend/database/schema.md` | Update schema documentation |

## Verification

After all phases are complete, verify:

- [ ] `documents` table has no `yjs_state` or `ai_content` columns
- [ ] `collab_document_snapshots` table does not exist
- [ ] `collab_request_idempotency` table does not exist
- [ ] `projects` table has no `auto_accept_proposals` column
- [ ] `document_updates`, `document_checkpoints`, `document_bookmarks` tables exist
- [ ] Proposal table has `pending`/`accepted`/`rejected`/`stale`/`reverted`/`invalid` statuses
- [ ] Proposal table has `region_text_before`, `region_text_after`, `proposed_at_offset`, `accepted_at_offset`
- [ ] No backend code path accepts or rejects proposals (grep for `MarkAccepted`, `MarkRejected`)
- [ ] No `ai_content` column references in backend code (grep for `ai_content` — the projector file should be renamed to `projected_state_builder.go` and contain no `ai_content` column references, only `BuildProjectedState()`)
- [ ] `ProjectedStateBuilder` interface exists and is used by mutation strategy for AI context
- [ ] No idempotency store references (grep for `IdempotencyStore`, `idempotency`)
- [ ] No arbiter references (grep for `Arbiter`, `arbiter`)
- [ ] Project WS only handles `heartbeat` inbound (no proposal commands)
- [ ] `_proposal_status` Y.Map is bootstrapped on document creation/load
- [ ] Status mirror observes Yjs sync deltas and upserts proposal rows
- [ ] Compaction worker runs with advisory lock and correct bookmark handling
- [ ] Frontend accept/reject are local Yjs transactions (no WS round-trip)
- [ ] UndoManager tracks `ORIGIN_ACCEPT`, `ORIGIN_REJECT`, `ORIGIN_THREAD`, `ORIGIN_HUMAN`
- [ ] UndoManager does NOT track `ORIGIN_GC` or `null`
- [ ] Thread undo/reapply uses offset-anchored search (no full-document fallback)
- [ ] Turn-level restore is backend-coordinated with safety bookmarks

## Cross-References

- [Target Architecture](target-architecture.md)
- [Target API](target-api.md)
- [Implementation Plan](../spec/plan.md)
