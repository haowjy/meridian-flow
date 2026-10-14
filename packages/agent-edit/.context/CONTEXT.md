# agent-edit — contracts and architecture

Agent-edit is a reusable Yjs editing kernel. It owns model-facing document
reads/writes, response-scoped commit buffering, write handles, and forward
inverse computation over host-provided ports; it does not own application persistence,
routes, authentication, or Meridian work/project concepts.

## Context map

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md) — journal, coordinator, lifecycle, codec,
  model, session-store, and core interfaces.
- [Write architecture](write-architecture.md) — module boundaries, codec flow,
  semantic certification, edit application, and forward inverses.
- [Write invariants](write-invariants.md) — block identity, destructive-edit
  safety, synchronization, and resolver constraints.
- [Diff and review model](diff-review.md): `@meridian/agent-edit/diff`, the
  base, changes, content Apply and local Discard, the rebase, and late peers.
- [Link identity](link-correspondence.md) — ref assignment at every write
  door, find-splice restoration, shown-link facts, and exact correspondence.
- [Write tool surface](write-tool-surface.md) — lifecycle behavior, outcomes,
  simplifications, and test coverage.

Deferred work remains in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
alternatives live in [ALTERNATIVES.md](ALTERNATIVES.md).

## Host revision identity

The required `DocumentLinksPort.revision(doc, scope)` identifies the exact
runtime read or authority apply, synchronously, in the command's prepared
link scope (so a host can make a tree-only move change it). Its result stays on host outcomes and response
receipts, not `AgentEditResultV1`. A host without revision identity, or recovery
without proof of the original apply state, returns null.

## Pinned reconstruction adapter

The browser-safe package subpath `@meridian/agent-edit/yjs-mutation` exports only
`src/yjs-mutation.ts`. It owns the Yjs 13.6.31 retained-struct lookup, root/nested
parent resolution, fresh-item integration and tombstone splitting/transfer.
The dependency is exactly pinned in package.json. Recovery and forward-inverse
hosts choose operations, supply identity mapping and own transaction/lifecycle
policy; the adapter copies an item's own content, never its descendants.
Keep version-sensitive reconstruction mechanics here rather than in app/undo
copies. This subpath imports only Yjs, not the package barrel or undo engine.
