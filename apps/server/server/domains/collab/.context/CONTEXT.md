# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

Model writes pass the frozen `ThreadExecutionContext` through `agentEdit`.
Direct-mode contexts (`draftOwner === null`) select the live core and create no
Work draft or thread-peer branch, including Auto-apply on No Work. Draft-mode
contexts select the thread-peer core; Draft on No Work owns a Work draft keyed
`(documentId, workId)`.
Draft-only operations must cross `requireWorkDraftOwner` and return typed
`work_required` rather than manufacturing an owner.

## Composition root

`composition.ts` is wiring-only: adapter and service instantiation,
config-driven provider selection, dependency-graph assembly, and returning
`CollabDomain`. Application behavior lives in dedicated `domain/` services with
**required** constructor dependencies. `collab-facade.ts` only assembles those
services; it owns no behavior.

The optional-feature matrix is deleted. Production constructs every service with
real adapters. In-memory composition supplies the same interfaces with explicit
in-memory or declared-stub implementations at the composition site. An
environment that lacks a capability declares a stub in one place rather than
omitting an optional field. Optional capability bags let a path silently drop a
required operation.

The real-Postgres change-trail harness types its local collab handle around the
capabilities it exercises. It must not cast to a complete `CollabDomain`.

Method bodies beyond delegation, conditional business behavior, and mutable
runtime state do not belong in the composition root. Durable projection for
ordinary writes and push completion shares one `DocumentProjectionEffects` port
without collapsing their distinct caller contracts.

## Reference map

- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Branch model, provenance, manifests, and durable records](branch-model-and-records.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Draft/live visual model](draft-live-model.html)
