# agent-edit — contracts and architecture

Agent-edit is a reusable Yjs editing kernel. It owns model-facing document
reads/writes, response-scoped commit buffering, write handles, and cold
undo/redo over host-provided ports; it does not own application persistence,
routes, authentication, or Meridian work/project concepts.

## Context map

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md) — journal, coordinator, lifecycle, codec,
  model, session-store, and core interfaces.
- [Write architecture](write-architecture.md) — module boundaries, codec flow,
  semantic certification, tiered application, and cold reversal.
- [Write invariants](write-invariants.md) — block identity, destructive-edit
  safety, synchronization, and resolver constraints.
- [Write tool surface](write-tool-surface.md) — lifecycle behavior, outcomes,
  simplifications, and test coverage.

Deferred work remains in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
alternatives live in [ALTERNATIVES.md](ALTERNATIVES.md).
