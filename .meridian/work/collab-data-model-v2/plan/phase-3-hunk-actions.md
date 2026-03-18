# Phase 3: Immediate Hunk Actions + Session Undo (Full-Stack)

## Scope and Intent

Wire hunk accept/reject as immediate Yjs transactions, implement auto-apply mode (frontend + backend tab election), set up UndoManager, and add mode switch confirmation. This is **full-stack** — includes backend changes for auto-apply tab election and cleanup of old server-side accept/reject paths.

## Dependencies

- **Requires:** Phase 2 complete (projection pipeline working, `BuildProjectedState` per-user, validation live)

## Files to Modify

| File | Change |
|------|--------|
| `toy/frontend.html` | Wire accept/reject transactions, UndoManager setup, auto-apply handler, mode switch with confirmation |
| Dev CM6 route | Wire accept/reject buttons to Yjs transactions, UndoManager integration |
| `backend/internal/handler/collab_project.go` | Remove `proposal:accept`, `proposal:reject`, `proposal:groupAccept`, `proposal:requestUpdate` command handling. Add owner-tab presence tracking. |
| `backend/internal/handler/collab_proposal.go` | Remove `handleProposalAccept`, `handleProposalReject`, `handleProposalGroupAccept`, `handleProposalRequestUpdate`, `broadcastProposalMutations`, `sendProposalSnapshot`, all idempotency helpers. Keep `proposal:new` broadcast. |
| `backend/internal/service/collab/proposal_service.go` | Remove `AcceptProposal`, `RejectProposal`, `GroupAccept` methods. Add backend fallback apply (0 owner tabs). |
| `backend/internal/service/collab/proposal_service_helpers.go` | Remove idempotency replay, auto-accept resolution, arbiter evaluation. |
| `backend/internal/service/collab/agent_arbiter.go` | Remove entirely |
| `backend/internal/service/collab/arbiter_strategy_*.go` | Remove entirely |
| `backend/internal/service/collab/proposal_accept_gate.go` | Remove entirely |
| `backend/internal/repository/postgres/collab/auto_accept_store.go` | Remove entirely |
| `backend/internal/domain/services/collab/collab.go` | Remove `AgentArbiter`, `ArbiterStrategy`, `AutoAcceptPolicyStore`, `AcceptProposalRequest/Result`, `RejectProposalRequest/Result`, `GroupAcceptRequest/Result`, `ProposalMutationIntent`, `ArbiterInput/Decision/Verdict`, `AutoAcceptPolicyInputs` |
| `backend/internal/domain/models/collab/proposal.go` | Remove `ProposalDecision` type |
| `backend/cmd/server/main.go` | Remove arbiter, auto-accept store, idempotency store wiring. Simplify `proposalService` constructor. Remove snapshot handler + routes. |
| Migration (new) | Remove `projects.auto_accept_proposals` column |

## Frontend Implementation

### Accept Hunk Transaction
```typescript
undoManager.stopCapturing();
canonicalDoc.transact(() => {
    for (const proposal of hunk.proposals) {
        Y.applyUpdate(canonicalDoc, proposal.yjs_update);
        canonicalDoc.getMap('_proposal_status').set(proposal.id, 'accepted');
    }
}, ORIGIN_ACCEPT);
// Persist accepted_at_offset via REST (async, non-blocking)
```

### Reject Hunk Transaction
```typescript
undoManager.stopCapturing();
canonicalDoc.transact(() => {
    for (const proposal of hunk.proposals) {
        canonicalDoc.getMap('_proposal_status').set(proposal.id, 'rejected');
    }
}, ORIGIN_REJECT);
```

### UndoManager Setup
```typescript
const undoManager = new Y.UndoManager(
    [doc.getText('content'), doc.getMap('_proposal_status')],
    { trackedOrigins: new Set([ORIGIN_HUMAN, ORIGIN_ACCEPT, ORIGIN_REJECT, ORIGIN_THREAD]) }
);
```

### Mode Switch Confirmation
```typescript
if (undoManager.undoStack.length > 0) {
    const confirmed = await showConfirmation("Switching modes will clear your undo history. Thread undo is unaffected.");
    if (!confirmed) return;
}
undoManager.clear();
```

### Auto-Apply Handler
```typescript
// On receiving proposal:new WebSocket event
ws.on('proposal:new', async ({ proposal_id, document_id }) => {
    const proposal = await api.getProposal(proposal_id);
    if (proposal.status !== 'pending') return;  // reconnect race guard

    const statusMap = doc.getMap('_proposal_status');
    if (statusMap.has(proposal_id)) return;  // multi-tab guard

    undoManager.stopCapturing();
    doc.transact(() => {
        Y.applyUpdate(doc, proposal.yjs_update);
        statusMap.set(proposal_id, 'accepted');
    }, ORIGIN_ACCEPT);
});
```

## Backend Implementation

### Owner Tab Presence

Track connected owner tabs per document via WebSocket connection registry:
- On document WS connect: if user is document owner, increment owner tab count
- On document WS disconnect: decrement owner tab count
- Expose `HasOwnerTabs(documentID) bool`

### Backend Fallback Apply

In `CreateProposal()`, after creating the proposal row:
1. If `HasOwnerTabs(documentID)` → broadcast `proposal:new`, do NOT apply
2. If NO owner tabs → apply `yjs_update` directly to canonical Y.Doc (not with `ORIGIN_ACCEPT` — not undoable), set `_proposal_status[proposalID] = 'accepted'`

## Cleanup

| Artifact | Action |
|----------|--------|
| `handleProposalAccept/Reject/GroupAccept` | Remove from `collab_proposal.go` |
| `broadcastProposalMutations`, `sendProposalSnapshot` | Remove |
| All idempotency helpers | Remove |
| `AcceptProposal`, `RejectProposal`, `GroupAccept` on ProposalService | Remove |
| `agent_arbiter.go` + all strategy files + tests | Remove entirely |
| `proposal_accept_gate.go` | Remove |
| `proposal_service_helpers.go` | Gut (remove idempotency, auto-accept, arbiter; keep any remaining helpers) |
| `auto_accept_store.go` | Remove entirely |
| `AutoAcceptPolicyStore` interface + types | Remove from `collab.go` |
| `AgentArbiter`, `ArbiterStrategy` interfaces + types | Remove from `collab.go` |
| `ProposalDecision` type | Remove from model |
| `projects.auto_accept_proposals` column | Drop via migration |
| WS commands `proposal:accept/reject/groupAccept/requestUpdate` | Remove routing |
| WS events `proposal:statusChanged/groupAcceptResult/updateData/snapshot` | Remove sending (keep `proposal:new`) |
| Snapshot handler + routes | Remove (replaced by bookmark API in future) |

## Verification Criteria

- [ ] Accept hunk applies all proposal `yjs_update`s + sets `_proposal_status` in one Yjs transaction
- [ ] Reject hunk sets `_proposal_status` only (no text change) in one Yjs transaction
- [ ] `stopCapturing()` is called before every discrete action
- [ ] One Ctrl-Z undoes the entire grouped hunk accept (multi-proposal = one undo step)
- [ ] One Ctrl-Z undoes the entire grouped hunk reject
- [ ] Interleaved undo/redo across typing and hunk actions works correctly
- [ ] Auto-apply: `proposal:new` triggers apply with `ORIGIN_ACCEPT` on owner tab
- [ ] Auto-apply multi-tab guard: second tab skips if `_proposal_status` already has entry
- [ ] Auto-apply reconnect guard: skip if proposal status != `pending` on REST fetch
- [ ] Backend fallback: 0 owner tabs → backend applies directly
- [ ] Mode switch prompts confirmation when undo stack non-empty
- [ ] `undoManager.clear()` called on mode change
- [ ] No `proposal:accept/reject/groupAccept` WS commands in backend (grep)
- [ ] No `AcceptProposal/RejectProposal/GroupAccept` in ProposalService (grep)
- [ ] No arbiter references in code (grep: `Arbiter`, `arbiter`)
- [ ] No `auto_accept_store` references (grep)
- [ ] No `IdempotencyStore` references (grep, if not already done in Phase 2a)
- [ ] `go build ./...` passes
