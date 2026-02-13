---
detail: minimal
audience: developer
---
# Phase 4: Multi-Agent Arbitration

**Status:** In planning  
**Priority:** High  
**Purpose:** Let multiple AI agents propose concurrently while keeping document state deterministic for writers.

## In Scope

- Serialized proposal acceptance per document.
- Admission policy (payload/range/rate limits).
- Arbitration policy (default FIFO + overlap/conflict checks).
- Queue/backpressure behavior for high proposal volume.

## Out of Scope

- Human multi-user presence and permissions model.

## Deliverables

- `AgentArbiter` policy surface with pluggable strategies.
- Server-enforced admission + chunking policy.
- Conflict tiers with explicit outcomes (`auto-rebase`, `review`, `conflicted`).
- Writer-safe queue limits and overflow handling.

## Dependencies

- Phase 3 proposal lifecycle.
- Supporting refresh strategy for live queue/status visibility.
- Admission/conflict/rate contracts from `_docs/plans/collab-ai/spec/api-events-contract.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/api-events-contract.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`

## Exit Criteria

- Concurrent agent proposals never corrupt authoritative version order.
- Overlapping proposals produce deterministic conflict outcomes.
- Proposal volume is bounded without UI or transport collapse.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/refresh-read-model-framework.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
