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

## Document revision identity

`domain/document-revision.ts` hashes the encoded Yjs snapshot (state vector
and delete set) as `y1:<base64url SHA-256>`. A state-vector-only token misses
pure deletion. This host callback is injected into both agent-edit cores.
Reads hash the private rendered runtime doc synchronously. Applies hash the
authority/peer doc immediately after `Y.applyUpdate`, before any await.
Response receipts retain that token through result rewriting; an unverified
recovery returns null, never a later read's token.

Effective markdown/hashline reads return content and revision from the same
callback. `readEffectiveRevision` uses their synchronous pull/fallback chain.
Context selects live authority for direct mode and the thread view for draft
mode. A thread rebind is resolved anew on each query.

Live pulls and peer content pulls commit in root transactions, never in a
caller's ambient transaction. Shared pull promises represent committed state;
caller rollback cannot undo them. Debounce timers clear only after commit.
Reruns leave the initiating transaction context.

Peer provisioning retains the canonical thread authority lock in the caller's
transaction, then commits branch infrastructure in a separate root transaction.
The root must not reacquire the thread row: a caller may already hold it.
Callers release live/branch access before taking that authority lock (they pass
detached snapshots). Pull callbacks never acquire it. Reads without a thread
peer flush live into the shared Work draft without creating a peer.

Direct response finalization invokes the receipt callback after the live core's
durable commit; the thread-peer core invokes it inside its host transaction.


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

Manifest identity and its durable live head are root-committed infrastructure
before any peer can reference them. Root provisioning resolves committed Work
membership, not a caller's speculative rebind. Work lifecycle locks use NO KEY
UPDATE so independent branch FK references can be installed while a caller
holds that lock. Authored branch mutations still take the Work lifecycle lock;
parent replication uses the existing snapshot CAS without taking it again,
because replication creates no reviewable edit. This distinction is necessary
for effective reads within Work-scoped context commands.

A caller joining an in-flight live pull waits for the coalesced next pull: the
old snapshot may precede its call. Failed background pulls are reported; expired
timer handles are removed so future updates re-arm the maximum debounce.
