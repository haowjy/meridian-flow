---
detail: standard
audience: developer, architect
---
# Collab Review v2: Server-Authoritative Hunks + Proposal Undo

**Status:** draft

## Why

The current proposal review system derives hunks entirely on the frontend, making undo impossible and multi-client consistency unenforceable. `ai_content` goes stale between proposal lifecycle events, and auto-snapshot TTL deletes recovery points too aggressively for fiction writers.

## What Changes

| Area | Current State | Target State |
|------|--------------|--------------|
| Hunk derivation | Frontend-only (diff computed in browser) | Backend derives hunks at proposal creation; hunks are server-authoritative records with state transitions |
| Undo support | None -- accept is permanent, reject is frontend-only | Yjs UndoManager with tracked origins; deferred finalization enables undo for accepts and rejects |
| `ai_content` freshness | Updates only on proposal lifecycle events; stale when user types between AI edits | During persistence: `ai_content = content` when no pending proposals exist; eliminates staleness with auto-accept ON |
| Snapshot retention | Auto-snapshots deleted after 7-day TTL | No TTL cleanup; auto-snapshots kept indefinitely (storage is negligible) |

## Design Docs

| Doc | Purpose |
|-----|---------|
| `spec/architecture.md` | Target architecture and data flow diagrams |
| `spec/backend-hunk-authority.md` | Backend hunk derivation, data model, API |
| `spec/proposal-undo.md` | Undo system, tracked origins, deferred finalization |
| `spec/plan.md` | Implementation phases and agent headcount (planned) |

## Dependencies

- **ws-transport-v2 Stage 1 complete** -- per-document WebSocket is the transport foundation for hunk-level server events
- **Current proposal system stable** -- this redesign builds on the existing proposal lifecycle, not a greenfield replacement

## Relationship to Existing Plans

- **Builds on** `collab-ai/phase/phase-5-proposal-review-redesign.md` -- refines the concepts into implementable specs
- **Depends on** `ws-transport-v2/` -- per-document WS transport layer
- **References** `_docs/technical/collab/` -- inline review, ai-content projection, ai-edit-flow documentation
