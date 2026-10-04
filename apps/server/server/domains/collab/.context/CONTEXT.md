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
mode. A thread rebind is resolved anew on each query. A draft read with no
thread peer flushes live into the shared Work draft and reads it; it never
creates a peer, so search stays read-only in branch topology while seeing the
state a later `write read` forks from.

Direct response finalization invokes the receipt callback after the live core's
durable commit; the thread-peer core invokes it inside its host transaction.

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
runtime state do not belong in the composition root. Activity effects stay separate
from document derivation.

## Durable document derivation

`domain/document-derivations.ts` is the sole projection pipeline. The write hook
runs it immediately; WebSocket admissions and generation replacement schedule it
with a two-second trailing debounce and ten-second maximum wait. Push completion
runs the same derive in its ambient completion transaction, so journal, projection,
watermark, and settlement roll back together.

The store captures checkpoint plus current-generation journal under the document
mutation lock. Never substitute a warm room: a socket admission can already be
durable while Hocuspocus has not applied it. Certification retakes the mutation
lock, checks generation and `next_admission_sequence`, and conditionally updates
the document at the captured `location_version`. A move increments that counter
at the common `recordDocumentMove` seam, including same-source folder renames.
Serialization runs outside the lock unless the caller already owns a transaction.
For an initialized live document, lifecycle ensure is read-only: retaining an
ambient head-row update lock would deadlock the subsequent root journal batch.
The root batch still commits before live apply; derivation can then join the
context command transaction.
A changed cut retries three times, then remains stale for recovery.

`document_derivations` certifies projection output by generation, next admission
sequence, location version, and extractor version. Equal cuts are idempotent;
older cuts cannot replace newer output. Projection byte size comes from the same
certified serialization. Changing the extractor invalidates older output: bump
its version when adding link extraction and add the output and link watermarks
to the existing certification transaction, not a second post-write hook.

The recovery scheduler sweeps database staleness at startup and every ten seconds,
at most 100 stale documents returned per pass with a wraparound cursor. This
limits derivation work, not query scan work: an entirely current corpus is
scanned in full on every idle pass. Scoped `flush` pages all stale
documents in a project, or every project owned by `personalOwnerId`. Both ignore
caller transactions and timer queues. Failed derives log and retain last-good
output without advancing certification; a later sweep retries them.

## Reference map

- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Branch model, provenance, manifests, and durable records](branch-model-and-records.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Draft/live visual model](draft-live-model.html)
