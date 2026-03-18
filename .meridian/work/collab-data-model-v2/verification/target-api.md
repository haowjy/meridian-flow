---
detail: standard
audience: developer, architect
---
# Target API Surface

Complete list of endpoints, WebSocket events, and internal interfaces after v2 is complete.

## REST Endpoints

### Existing (unchanged)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/ws/documents/{documentId}` | Yjs sync + awareness (binary WebSocket) |
| `GET` | `/ws/projects/{projectId}` | Project-level events (JSON WebSocket) |

### Existing (modified)

| Method | Path | Change |
|---|---|---|
| `POST` | `/api/documents` | Must bootstrap `_proposal_status` Y.Map in new canonical Y.Doc |
| `GET` | `/api/documents/{id}` | No longer returns `ai_content` (column removed) |

### New

| Method | Path | Purpose |
|---|---|---|
| `PATCH` | `/api/proposals/{id}/offset` | Persist `accepted_at_offset` with monotonic version. Called by frontend after accept transaction or thread reapply (any transition into `accepted`). |
| `GET` | `/api/documents/{id}/proposals` | List proposals for a document (with status filter). Replaces WS `proposal:snapshot`. |
| `GET` | `/api/proposals/{id}` | Get single proposal (including `yjs_update` bytes). Replaces WS `proposal:requestUpdate`. |
| `POST` | `/api/turns/{id}/restore` | Turn-level restore: create safety bookmarks, replace Y.Doc state for all documents with `ai_turn` bookmark for this turn. Returns list of affected document IDs. |
| `POST` | `/api/turns/{id}/undo-restore` | Undo restore: restore from safety bookmarks for this turn. |

### Removed

| Method | Path | Reason |
|---|---|---|
| `POST` | `/api/documents/{id}/snapshots` | Replaced by `document_bookmarks` (different semantics) |
| `GET` | `/api/documents/{id}/snapshots` | Replaced by bookmark API (if user-facing) |
| `GET` | `/api/documents/{id}/snapshots/{snapshotId}/content` | Removed with snapshot table |
| `POST` | `/api/documents/{id}/snapshots/{snapshotId}/restore` | Replaced by turn-level restore |
| `DELETE` | `/api/documents/{id}/snapshots/{snapshotId}` | Removed with snapshot table |

### Thread/Turn Proposal Lookup

The thread UI needs to map tool calls to proposals for status overlays and Undo All. This uses existing infrastructure:

- **Per-turn proposals**: `GET /api/documents/{id}/proposals?turn_id={turnId}` (status filter + turn_id filter on existing endpoint)
- **Thread turn data**: `GET /api/threads/{id}/turns` already returns turn payloads including tool_use blocks. The frontend correlates `turn_id` on proposal rows with tool call blocks in the turn.
- **Undo All**: Frontend iterates accepted proposals for the thread's turns. No dedicated "undo all" endpoint — the frontend performs individual thread undo operations client-side.

### Future (not in v2 scope)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/documents/{id}/bookmarks` | List bookmarks (user-facing manual/daily) |
| `POST` | `/api/documents/{id}/bookmarks` | Create manual bookmark ("Save Version") |
| `DELETE` | `/api/bookmarks/{id}` | Delete manual bookmark |
| `GET` | `/api/documents/{id}/timeline` | Document timeline with bookmark restore points |

## WebSocket Events

### Project WebSocket (`/ws/projects/{projectId}`)

#### Server-to-Client Events

| Type | Payload | When |
|---|---|---|
| `project:connected` | `{}` | Auth success |
| `proposal:new` | `{ proposal_id, document_id, status }` | New proposal created (AI edit or human suggestion) |

#### Client-to-Server Commands

| Type | Payload | Notes |
|---|---|---|
| `heartbeat` | `{}` | Keepalive |

#### Removed Commands

| Type | Reason |
|---|---|
| `proposal:accept` | Replaced by local Yjs transaction |
| `proposal:reject` | Replaced by local Yjs transaction |
| `proposal:groupAccept` | Replaced by local Yjs transaction (grouped hunk accept) |
| `proposal:requestUpdate` | Replaced by REST `GET /api/proposals/{id}` |
| `proposal:snapshot` | Replaced by REST `GET /api/documents/{id}/proposals` on connect |

#### Removed Server Events

| Type | Reason |
|---|---|
| `proposal:statusChanged` | Status changes flow through Yjs sync, not separate WS events |
| `proposal:groupAcceptResult` | No server-side group accept |
| `proposal:updateData` | Replaced by REST |
| `proposal:snapshot` | Replaced by REST |

### Document WebSocket (`/ws/documents/{documentId}`)

Unchanged. Binary Yjs sync protocol + awareness.

## Internal Interfaces

### Backend Domain Services

```go
// ProposalService — what remains after removing accept/reject/groupAccept
type ProposalService interface {
    CreateProposal(ctx context.Context, req CreateProposalRequest) (*Proposal, error)
    // Accept/Reject/GroupAccept are REMOVED — decisions are local Yjs transactions
}

// StatusMirror — NEW: observes Yjs sync deltas
type StatusMirror interface {
    // Called on each _proposal_status Y.Map delta from Yjs sync
    OnStatusChange(ctx context.Context, proposalID uuid.UUID, status string) error
    // Called on document load for full reconciliation
    ReconcileAll(ctx context.Context, documentID uuid.UUID, statusMap map[string]string) error
}

// UpdateLogStore — NEW: replaces DocumentStateStore
type UpdateLogStore interface {
    AppendUpdate(ctx context.Context, docID uuid.UUID, update []byte, origin string, userID *uuid.UUID) (int64, error)
    LoadSinceCheckpoint(ctx context.Context, docID uuid.UUID) (checkpoint []byte, updates [][]byte, error)
}

// BookmarkStore — NEW: replaces SnapshotStore
type BookmarkStore interface {
    Create(ctx context.Context, bookmark *Bookmark) error
    ListByDocumentAndTurnID(ctx context.Context, docID uuid.UUID, turnID uuid.UUID) ([]Bookmark, error)
    GetState(ctx context.Context, bookmarkID uuid.UUID) ([]byte, error)
    DeleteByTypeAndCutoff(ctx context.Context, docID uuid.UUID, bookmarkType string, cutoffUpdateID int64) error
    MaterializeState(ctx context.Context, bookmarkID uuid.UUID, state []byte) error
}

// CompactionWorker — NEW
type CompactionWorker interface {
    CompactIfNeeded(ctx context.Context, docID uuid.UUID) error
}

// RestoreService — NEW: backend-coordinated turn-level restore
type RestoreService interface {
    RestoreTurn(ctx context.Context, turnID uuid.UUID) (*RestoreResult, error)
    UndoRestore(ctx context.Context, turnID uuid.UUID) (*RestoreResult, error)
}

// ProjectedStateBuilder — SURVIVING: builds Yjs state with pending proposals applied
// Used by mutation strategy (CollabProposalStrategy) so AI edit positions align with
// the projected content, and by LLM streaming service for AI document reads.
// Previously part of AIContentProjector; Recompute() is removed but this stays.
// NOTE: userID parameter is required — projection is per-user (only that user's
// pending proposals are applied). The AI sees its owner's projected view.
type ProjectedStateBuilder interface {
    BuildProjectedState(ctx context.Context, documentID uuid.UUID, userID uuid.UUID) ([]byte, error)
}

// ProposalStore — MODIFIED: remove decision methods, add mirror + offset
type ProposalStore interface {
    Create(ctx context.Context, proposal *Proposal) error
    GetByID(ctx context.Context, proposalID uuid.UUID) (*Proposal, error)
    ListByDocument(ctx context.Context, documentID uuid.UUID, status *ProposalStatus, limit int, offset int) ([]Proposal, error)
    // NEW: status mirror upsert (from Yjs sync deltas)
    UpsertStatus(ctx context.Context, proposalID uuid.UUID, status ProposalStatus) error
    // NEW: accepted_at_offset persistence with monotonic version guard
    SetAcceptedAtOffset(ctx context.Context, proposalID uuid.UUID, offset int, version int) error
    // REMOVED: MarkAccepted, MarkRejected, markTerminalStatus, getCurrentStatus
    // REMOVED: CountByDocumentAndStatusAndSource, ListByGroup (proposal_group_id is gone)
}
```

### Backend Domain Services (removed)

```go
// REMOVED — no longer needed
type AcceptProposalRequest struct { ... }
type AcceptProposalResult struct { ... }
type RejectProposalRequest struct { ... }
type RejectProposalResult struct { ... }
type GroupAcceptRequest struct { ... }
type GroupAcceptResult struct { ... }
type ProposalMutationIntent struct { ... }
type AgentArbiter interface { ... }
type ArbiterStrategy interface { ... }
type AutoAcceptPolicyStore interface { ... }
type AIContentProjector interface { ... }  // Interface removed; replaced by ProjectedStateBuilder (above)
type AIContentReader interface { ... }     // No ai_content column to read
type IdempotencyStore interface { ... }
```

### Frontend Interfaces

```typescript
// Projection pipeline
interface DeriveResult {
  hunks: GroupedHunk[];
  sequenceNumber: number;  // for freshness guard
}

// Grouped hunk (user-facing region)
interface GroupedHunk {
  proposals: ProposalRef[];
  canonicalRange: { from: number; to: number };
  insertedText: string;
  deletedText: string;
}

// Thread operations
interface ThreadUndoResult {
  success: boolean;
  conflict?: string;  // "text was edited"
}
```

## Proposal Row Schema (target)

```sql
CREATE TABLE proposals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES documents(id),
    thread_id           UUID NOT NULL,
    created_by_user_id  UUID NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'stale', 'reverted', 'invalid')),
    yjs_update          BYTEA NOT NULL,
    region_text_before  TEXT,
    region_text_after   TEXT,
    proposed_at_offset  INT,
    accepted_at_offset  INT,
    turn_id             UUID,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### Columns Removed from Current Proposal Table

| Column | Reason |
|---|---|
| `source` | Proposals are participant-agnostic in v2 (but may keep for analytics) |
| `producer_agent_type` | Same rationale |
| `agent_run_id` | Same rationale |
| `proposal_group_id` | Grouped hunks are ephemeral (computed from projection, not stored) |
| `description` | Moves to thread/turn level, not per-proposal |
| `decided_by_user_id` | Decision authority is Yjs, not backend |
| `decided_at` | Same rationale |

Note: `source` and `producer_agent_type` may be kept for analytics/provenance even though the v2 model doesn't depend on them. Decision deferred to Phase 1 implementation.

## Cross-References

- [Target Architecture](target-architecture.md)
- [Cleanup Checklist](cleanup-checklist.md)
- [Schema Design](../spec/schema-design.md)
- [Local-First Authority](../spec/local-first-authority.md)
