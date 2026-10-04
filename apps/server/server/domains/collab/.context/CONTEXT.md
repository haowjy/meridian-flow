# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

Model reads and writes go through `agentEdit()`, the thread-peer core pool,
with a destination per document (below). A `live` destination selects the
live core and creates no Work draft or thread-peer branch: Auto-apply,
Auto-apply on No Work, and `scratch://` and `uploads://` in every mode. A
`draft` destination selects the thread-peer core; Draft on No Work owns a Work
draft keyed `(documentId, workId)`.

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
Every effective read, `readEffectiveRevision` included, names a
`destination`: `live` reads live authority (plus the reply's own staged live
writes) and never touches a Work draft, kept or not; `draft` reads the thread
view. A reply's staged writes overlay only reads of the destination they were
pinned to, so a live read never shows the reply's drafted edits. A thread rebind is resolved anew on each query. A draft read with no
thread peer flushes live into the shared Work draft and reads it; it never
creates a peer, so search stays read-only in branch topology while seeing the
state a later `read` forks from.

## One save per reply

The thread-peer pool is the only model read/write entry point. Each call
carries the `FileGrant` the caller got from `domains/file-policy`; its
destination routes the call. A write that commits now runs under
`runWithEditGrants`; a reversal whose writes landed in the other journal gets
a fresh `authorize` at that destination. A reply pins each document to its
first grant (reads follow the pin, except a `liveVersion` read, which is
`version: "live"` and always reads live; results report the version read in
`read.version`), may
own a live core and a thread core at once, and saves both, plus the reply's
records and the receipt callback, in one response transaction. The live
journal joins that transaction; the live agent-edit core's coordinator works
on a private copy of the room inside it and publishes through `recover()`
after commit, so a rollback shows nothing. The save first runs one
`confirmEdit` over every grant the reply wrote under, drops refused documents
(a Work archived mid-reply, D29) and reports them, then marks the rest
confirmed for the journal's no-grant guard. The pool
also records each document's last read version per thread (`live` or
`draft` of a Work); a write against another version returns `read_required`.

## Pull and provisioning transactions

Effective reads, and therefore `DocumentRevisions.current`, may run inside a
caller's thread-locked or Work-locked command transaction. These rules keep
that safe:

- **Pulls commit on their own.** Live→Work-draft pull bodies
  (`domain/branch-pulls.ts` `run()`) and thread-peer content pulls run in root
  transactions outside any caller's ambient transaction. A shared pull promise
  therefore resolves only on committed state, and a caller's rollback cannot
  undo it. Pulls also leave the response transaction context, so root-committed
  cache updates and broadcasts cannot be deferred to an aborting response.
  Reruns and timer callbacks leave both initiating contexts.
- **Joiners wait for the next run.** A caller that joins an in-flight live pull
  awaits one coalesced run that starts after its call. The in-flight snapshot
  may predate a writer edit the caller must observe.
- **Timers survive failure.** Debounce and maximum timers clear only after a
  pull commits with no newer run queued. An older commit cannot cancel retries
  for newer edits. A failed pull leaves them armed; a fired handle is cleared so
  the next update re-arms the maximum bound. Background failures go to
  `BranchPullDiagnostics.backgroundFailed`.
- **Provisioning splits authority from infrastructure.**
  `ensureThreadPeerBranch` takes the canonical thread row lock in the caller's
  (or its own enclosing) transaction, then commits the Work draft and thread
  peer in a root transaction. The root must not relock the thread row, since
  the caller may already hold it. It resolves committed Work membership, not a
  caller's uncommitted rebind. Callers release live/branch access before taking
  the thread lock (they pass detached snapshots); pull callbacks never take it.
- **Referenced rows commit first.** `ensureProjectManifest` creates manifest
  identity and its durable live head in a root transaction, so a root-committed
  peer never references a row only the caller's transaction can see. Live
  manifest writes (`mutateLiveManifest`, `reconcileProjectManifest`) instead
  call `loadProjectManifest` in the caller's transaction: during cold project
  bootstrap the project and source are uncommitted, and identity, content, and
  membership must roll back together. Live-only membership reads use that same
  ambient loader to see the caller's writes. Neither path provisions a root peer.
- **FK references must not wait on the caller's locks.** A root insert that
  references a row the caller locked waits on a transaction that is itself
  awaiting the root in JavaScript; Postgres never detects that cycle. Work
  lifecycle and thread locks therefore use `NO KEY UPDATE`, which admits FK
  `KEY SHARE`. Authored branch mutations (`commitBranchMutation`) still take the
  Work lifecycle lock. Replication pulls use the snapshot CAS
  (`updateBranchSnapshot`) without it, because replication creates no
  reviewable edit.

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
