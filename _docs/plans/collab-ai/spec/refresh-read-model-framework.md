---
detail: minimal
audience: developer
---
# Collaboration Spec: Read-Model Freshness

**Status:** In planning
**Priority:** Medium
**Purpose:** Define what frontend data channels exist and how non-collab data stays fresh.

## Scope Reduction

With the single-WebSocket architecture, **proposals are no longer HTTP data**. All proposal state (new, accepted, rejected) flows through the WebSocket connection. This eliminates:

- TanStack Query for proposal lists/status
- HTTP proposal endpoints
- WS event -> TanStack Query invalidation wiring
- Proposal query keys and mutation invalidation maps
- Custom coalescing/dedup for proposal data

## Two Data Channels (Simplified)

| Channel | Transport | State Layer | Data |
|---|---|---|---|
| **WebSocket** | Yjs sync + JSON frames | Yjs (`Y.Doc`) + Zustand (`useCollabStore`) | Document content, sync state, awareness/presence, **proposals** |
| **HTTP** | REST via existing patterns | Existing Zustand stores | File tree, thread list, user settings, document metadata |

WS handles all real-time collab data. HTTP handles non-collab UI state.

## What Remains

TanStack Query is **not introduced** for collab. Existing non-collab stores (projects, threads, tree) remain on Zustand unchanged.

### Non-Collab Refresh Targets (Unchanged)

These use existing Zustand store patterns:
- Project tree
- Active document metadata
- Thread list
- User settings

### Collab Refresh (Via WebSocket)

All collab data refreshes automatically through the WebSocket connection:
- Document content: Yjs sync protocol
- Proposals: baseline snapshot + JSON frames (`proposal:snapshot`, `proposal:new`, `proposal:statusChanged`, `proposal:groupAcceptResult`)
- Presence/awareness: Yjs awareness protocol
- Connection state: `useCollabStore`

Reconnect rule:
- After each successful auth+sync, server sends `proposal:snapshot` before incremental proposal events.

### Touched-Document Read Model

`turn_document_touches` tracks which documents were modified within a thread turn, populated from Yjs updates with matching provenance. This supports "what changed" review entrypoints. Refreshed via existing store patterns when navigating to review views.

## Exit Criteria

- Missed WS events self-heal on reconnect via Yjs sync for document state plus `proposal:snapshot` for proposal state.
- Non-collab read models stay coherent across tree/editor/thread surfaces using existing Zustand patterns.
- No request storm from bursty trigger sources.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/phase/phase-2-history-and-undo.md`
- `_docs/plans/collab-ai/phase/phase-3-ai-proposals-and-review.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
