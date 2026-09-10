# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

Model writes pass the frozen `ThreadExecutionContext` through `agentEdit`.
No-Work and direct-mode contexts select the live core and create no Work draft
or thread-peer branch; draft-mode Work contexts select the thread-peer core.
Draft-only operations must cross `requireWorkDraftOwner` and return typed
`work_required` rather than manufacturing an owner.

## Reference map

- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Branch model, provenance, manifests, and durable records](branch-model-and-records.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Draft/live visual model](draft-live-model.html)
