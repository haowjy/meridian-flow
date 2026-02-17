---
detail: minimal
audience: developer
---
# Phase 4: Multi-Agent Arbitration

**Status:** Complete (5 slices delivered)
**Priority:** High
**Purpose:** Let multiple AI agents propose concurrently while maintaining semantic quality for writers.

## In Scope

- Serialized proposal acceptance per document.
- Admission policy (payload/rate limits).
- Semantic quality arbitration (CRDT merges are conflict-free mechanically; arbitration focuses on whether the **result** makes sense).
- Queue/backpressure behavior for high proposal volume.
- Auto-accept tier refinement (low-risk auto-accept, large changes require review, contradictory edits flagged).

## Out of Scope

- Human multi-user presence and permissions model.

## Key Simplification (Yjs)

With Yjs CRDTs, mechanical conflicts (position shifts, version races) are eliminated. Multi-agent arbitration shifts from:
- ~~"Can these changes be rebased without position corruption?"~~ -> **Always yes** (CRDT guarantee)
- **"Does the combined result maintain semantic quality?"** -> This is the new arbitration focus

Conflict detection becomes a quality check, not a mechanical check.

## Deliverables

- `AgentArbiter` policy surface with pluggable strategies (semantic quality scoring).
- Server-enforced admission + rate policy (Go backend, single process).
- Semantic review tiers (auto-accept low-risk, require review for large changes, flag contradictory edits).
- Writer-safe queue limits and overflow handling.
- Proposal event/command shape changes consumed through `@meridian/cm6-collab` package APIs (no app-local forks).

## Dependencies

- Phase 3 proposal lifecycle.
- Admission/rate contracts from `_docs/plans/collab-ai/spec/api-events-contract.md`.
- Frontend package boundary contract from `_docs/plans/collab-ai/spec/cm6-library-model.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`

## Exit Criteria

- Concurrent agent proposals never corrupt document state (CRDT guarantee).
- Overlapping proposals produce semantically coherent results (quality arbitration).
- Proposal volume is bounded without UI or transport collapse.
- Arbitration-driven proposal behavior is integrated via `@meridian/cm6-collab` package contracts, not feature-local logic.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/cm6-library-model.md`
