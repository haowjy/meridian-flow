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
  semantic certification, edit application, and cold reversal.
- [Write invariants](write-invariants.md) — block identity, destructive-edit
  safety, synchronization, and resolver constraints.
- [Link correspondence](link-correspondence.md) — standalone pure identity
  assignment, exact tuple matching and observable bounded order completion.
- [Write tool surface](write-tool-surface.md) — lifecycle behavior, outcomes,
  simplifications, and test coverage.

Deferred work remains in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
alternatives live in [ALTERNATIVES.md](ALTERNATIVES.md).

## Host revision identity

The optional synchronous `documentRevision(doc)` host port identifies the exact
runtime read or authority apply. Its result stays on host outcomes and response
receipts, not `AgentEditResultV1`. A host without revision identity, or recovery
without proof of the original apply state, returns null.
