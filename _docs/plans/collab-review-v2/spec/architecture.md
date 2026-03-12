---
detail: standard
audience: developer, architect
---

# Collab Review v2: Target Architecture

**Status**: draft

## Overview

This redesign moves hunk derivation and state from the frontend to the backend, making the server the authority on review hunks. It adds undo support for hunk accept/reject via Yjs `UndoManager` with tracked origins and deferred finalization. It also fixes `ai_content` staleness during human editing and removes the aggressive 7-day TTL on auto-snapshots.

## Current vs Target Architecture

```mermaid
flowchart LR
    subgraph current["Current: frontend-derived hunks"]
        direction TB
        C_PS["ProposalService<br/>stores whole proposals"]
        C_FE["Frontend derives hunks<br/>clone Y.Doc, apply, extract deltas,<br/>group into ReviewHunks"]
        C_CM["CM6 StateField<br/>renders decorations"]
        C_PA["Partial apply<br/>buildPartialUpdate per hunk"]
        C_FIN["Auto-finalize<br/>always sends proposal:reject"]

        C_PS --> C_FE --> C_CM --> C_PA --> C_FIN
    end

    subgraph target["Target: backend-authoritative hunks"]
        direction TB
        T_PS["ProposalService"]
        T_HD["HunkDeriver<br/>same algorithm, server-side"]
        T_HS["HunkStore<br/>DB records per hunk"]
        T_API["Hunk API<br/>accept, reject, edit,<br/>undo-accept, undo-reject"]
        T_FE["Frontend receives hunks<br/>renders decorations,<br/>sends hunk commands"]
        T_UM["UndoManager<br/>tracked origins,<br/>deferred finalization"]

        T_PS --> T_HD --> T_HS
        T_HS --> T_API
        T_API --> T_FE
        T_FE --> T_UM
    end

    current ~~~ target
```

## Target Architecture Diagram

```mermaid
flowchart TB
    subgraph Backend
        PS["ProposalService<br/>CreateProposal()"]
        HD["HunkDeriver<br/>delta to positioned ops<br/>to merged ops to grouped hunks"]
        HS["HunkStore<br/>collab_proposal_hunks table"]
        HA["Hunk API operations"]
        SM["SessionManager<br/>ApplyUpdate with origin"]
        PROJ["AIContentProjector"]
        PB["ProposalBroadcaster"]

        PS -->|"on create"| HD
        HD -->|"persist derived hunks"| HS
        HS --> HA
        HA -->|"hunk:accept"| SM
        HA -->|"hunk:reject"| HS
        HA -->|"hunk:edit"| SM
        HA -->|"hunk:undo-accept"| SM
        HA -->|"hunk:undo-reject"| HS
        SM -->|"debounce persist"| PROJ
    end

    subgraph Frontend
        FE_R["Receive hunks<br/>from proposal:new event"]
        FE_D["Build CM6 decorations<br/>from server-provided hunks"]
        FE_C["Send hunk commands<br/>via project WS"]
        UM["UndoManager<br/>tracks proposal-accept origin"]
        DF["Deferred finalization<br/>delay reject until<br/>user takes next action"]

        FE_R --> FE_D
        FE_D --> FE_C
        FE_C --> UM
        FE_C --> DF
    end

    subgraph Persistence
        DB_H["collab_proposal_hunks<br/>id, proposal_id, base_start,<br/>base_end, deleted_text,<br/>inserted_text, status"]
        DB_D["documents<br/>yjs_state, content, ai_content"]
        DB_S["collab_document_snapshots<br/>TTL = 0 for auto-snapshots"]
    end

    PB -->|"proposal:new with hunks"| FE_R
    FE_C -->|"hunk:accept / reject / edit"| HA
    SM --> DB_D
    HS --> DB_H
    SM --> DB_S
    PROJ -->|"ai_content = content<br/>when no pending proposals"| DB_D
```

## Data Flow: Accept Hunk

```mermaid
sequenceDiagram
    participant W as Writer
    participant FE as Frontend
    participant UM as UndoManager
    participant WS as Project WS
    participant HA as Hunk API
    participant SM as SessionManager
    participant HS as HunkStore
    participant BC as Broadcaster

    W->>FE: Click "Keep" on hunk
    FE->>WS: hunk:accept (hunkId)
    WS->>HA: accept(hunkId)
    HA->>HS: Load hunk record
    HA->>SM: buildPartialUpdate(hunk)<br/>ApplyUpdate(origin: proposal-accept)
    SM->>SM: Apply to live Y.Doc
    HA->>HS: Mark hunk accepted
    HA->>BC: Broadcast Yjs update (binary)<br/>+ hunk:statusChanged (JSON)
    BC-->>FE: Yjs update arrives via doc WS
    FE->>FE: yCollab merges into CM6
    FE->>UM: UndoManager captures<br/>origin: proposal-accept
    BC-->>FE: hunk:statusChanged
    FE->>FE: Remove hunk decoration
```

## Data Flow: Reject Hunk

```mermaid
sequenceDiagram
    participant W as Writer
    participant FE as Frontend
    participant DF as Deferred Finalization
    participant WS as Project WS
    participant HA as Hunk API
    participant HS as HunkStore
    participant BC as Broadcaster

    W->>FE: Click "Discard" on hunk
    FE->>FE: Mark hunk rejected locally
    FE->>FE: Remove decoration immediately
    Note over FE,DF: Do NOT send to server yet
    FE->>DF: Queue deferred reject(hunkId)

    alt Writer presses Ctrl-Z before finalization
        W->>FE: Ctrl-Z
        FE->>DF: Cancel deferred reject
        FE->>FE: Restore hunk to pending
    else Writer takes next action (navigate, type, etc.)
        DF->>WS: hunk:reject (hunkId)
        WS->>HA: reject(hunkId)
        HA->>HS: Mark hunk rejected
        HA->>BC: hunk:statusChanged
        BC-->>FE: Confirm rejection
    end
```

## Data Flow: Undo Accept

```mermaid
sequenceDiagram
    participant W as Writer
    participant UM as UndoManager
    participant FE as Frontend
    participant WS as Project WS
    participant HA as Hunk API
    participant SM as SessionManager
    participant HS as HunkStore
    participant BC as Broadcaster

    W->>FE: Ctrl-Z
    FE->>UM: undo()
    UM->>UM: Reverse Y.Doc mutation<br/>(tracked origin: proposal-accept)
    UM-->>FE: Y.Doc reverted
    FE->>WS: hunk:undo-accept (hunkId)
    WS->>HA: undoAccept(hunkId)
    HA->>HS: Mark hunk pending
    HA->>SM: Yjs CRDT sync propagates<br/>the undo to server
    HA->>BC: hunk:statusChanged (pending)
    BC-->>FE: Hunk decoration restored
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Backend derives hunks on proposal create | Single source of truth. Two clients always see identical hunks. Enables server-side undo and hunk history. |
| Hunk records stored in DB | Server authority on hunk state. Supports `undo-accept`, `undo-reject`, and future per-hunk audit trail. |
| Same derivation algorithm (delta to ops to hunks) | Proven correct on frontend. Porting to Go avoids inventing a new grouping strategy. |
| `proposal:reject` replaced by per-hunk operations | Current finalization always sends `proposal:reject` regardless of hunk decisions. Per-hunk ops give the server accurate state. Proposal-level finalization becomes a server-side concern (all hunks resolved = proposal closed). |
| UndoManager with tracked origin `proposal-accept` | Yjs UndoManager natively supports selective undo by origin. Only proposal-accept mutations are reversible via Ctrl-Z; normal typing is unaffected. |
| Deferred finalization for reject | Reject has no Y.Doc mutation to undo. Deferring the server call lets Ctrl-Z flip a rejected hunk back to pending without a round-trip. Auto-finalizes when the writer moves on. |
| `ai_content = content` during persist when no pending proposals | Fixes staleness when auto-accept is ON (common case). Human typing between AI edits no longer desynchronizes `ai_content`. |
| Auto-snapshot TTL set to 0 (infinite) | Fiction writers may need to recover deleted scenes months later. Storage cost is negligible for text documents. |
| Frontend still renders decorations from hunk data | Server provides the hunk records; frontend maps them to CM6 decorations. No change to the decoration/rendering pipeline. |
| Proposal-level finalization is server-side | When all hunks in a proposal are resolved (accepted, rejected, or edited), the server closes the proposal automatically. Frontend does not need to track cross-hunk completion. |

## Scope

This redesign covers:
- Backend hunk derivation, storage, and API
- Hunk-level accept/reject/edit/undo operations
- UndoManager integration with tracked origins
- Deferred finalization for reject undo
- `ai_content` consistency fix during persistence
- Auto-snapshot TTL removal

This redesign does NOT cover:

| Out of scope | Why |
|-------------|-----|
| Suggestion mode UI (tracked-changes rendering) | Separate UX project; see `_docs/technical/collab/ideal-state.md` Priority 3 |
| Comment threads on hunks | Future feature; hunk records enable it but it is not part of this redesign |
| Transport unification (single WS) | Tracked separately in `_docs/plans/ws-transport-v2/` |
| Multi-user concurrent review | Hunk records support it structurally, but the UX for conflict resolution is a separate design |
| AI rationale per hunk | Requires LLM integration changes beyond the review system |
| Hunk edit UI (inline editing of proposed text) | The `hunk:edit` API operation is defined here, but the editor UI for modifying proposed text is a separate effort |

## Related

- [inline-review.md](../../../technical/collab/inline-review.md) -- Current frontend hunk derivation pipeline
- [ai-edit-flow.md](../../../technical/collab/ai-edit-flow.md) -- End-to-end AI edit flow
- [ai-content-projection.md](../../../technical/collab/ai-content-projection.md) -- Current ai_content recompute triggers
- [yjs-state-lifecycle.md](../../../technical/collab/yjs-state-lifecycle.md) -- Session manager, persistence, snapshots
- [ideal-state.md](../../../technical/collab/ideal-state.md) -- Long-term collab vision
- [ws-transport-v2 architecture](../../ws-transport-v2/spec/architecture.md) -- Transport redesign (separate effort)
