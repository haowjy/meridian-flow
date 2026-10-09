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
and delete set), the holder's URI and the sorted `[storedRef, storedHref,
spelledHref]` triples of every ref-bearing link and `asset:` source, as
`y2:<base64url SHA-256>`. A state-vector-only token misses pure deletion; a
snapshot-only token misses a tree-only move. It reaches both agent-edit cores
as `DocumentLinksPort.revision(doc, scope)`, with the command's prepared scope.
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
a fresh grant at that destination (`authorizeAt`). A reply pins each document to its
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

## Write mode and drafts

The Work's write mode decides only where new AI writes go. A draft write
never pushes itself live (D59): a reply that saves into the draft after the
writer switched the Work to Auto-apply waits there like a kept change, and
the dock shows it. Switching to Auto-apply with pending changes needs a
choice (`work-push-policy.ts`, D40): `apply` pushes each pending draft once,
then sets the mode; `keep` sets only the mode. An archived Work's `apply`
refuses at its first push, under the Work lock (D30). Branches carry no push
policy: turn trail work never pushes, and a due work row settles `no_op`
(`adapters/drizzle-turn-trail-work.ts`); a push or discard completes it
through the journal trigger.

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
  Reruns and timer callbacks leave both initiating contexts. A live pull first
  lists the document's active Work-draft branches outside any transaction and
  stops when there are none. Otherwise it takes its live snapshot before
  opening its root transaction, never while holding it: the snapshot needs its
  own connection, and pulls that each hold one while waiting for another
  exhaust the pool and deadlock. The root transaction lists the branches again,
  since one can close in between.
- **Room loads read in the caller's transaction.** A room opened under a
  command transaction loads its journal snapshot and validates its handle's
  authority generation through that transaction. The transaction may already
  hold the authority head row from an admission, so a second connection would
  wait on it forever.
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

## Concurrent branch attribution

Each preflight and final recheck uses its own upstream cut. Before replay,
exclude journal updates contained in the baseline Yjs snapshot (struct clocks
**and** delete set). Equal state vectors alone do not establish equality:
delete-only writer edits must still be attributed. An identical encoded
baseline/upstream skips block projection only when no novel journal rows remain,
including live rows not yet pulled into the draft. Never advance the journal
floor to a global maximum: it is a provisional, commit-bound attribution cursor,
not proof that every earlier row was visible in the baseline.

The filter removes repeated block projection and replay, not the history scan:
each pass still decodes every retained candidate row against the snapshot, so
its cost grows with retained journal bytes (see the cold-start scan in
[TODO.md](TODO.md)).

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
with a two-second trailing debounce and ten-second maximum wait. The projection
feeds search, listings and sizes, and the link index (download serves only
the live read: a projection can hold a pre-move path);
the Editor and AI read live Yjs, and renames flush first. Push completion
runs the same derive in its ambient completion transaction, so journal, projection,
watermark, and settlement roll back together.

One authority generation per checkpoint and per reconstruction. Live document
handles carry immutable authority identity and generation from
the same journal snapshot that loaded their bytes. Hocuspocus binds rooms during
load; coordinator acquisition/recovery may replay only a matching generation,
never relabel a warm handle. Room and explicit checkpoint producers, writer
frames, Markdown replacements, and agent journal batches carry that binding
into persistence. Agent response batches capture it during canonical-document
preflight; the host coordinator supplies it through the package port. Append
validation happens after acquiring the mutation lock, before admission allocation.
Restore marks acquired handles retired and disconnects the room; still-loading
rooms are retired when their load promise finishes;
load completion and connection creation revalidate the binding and evict stale
rooms, so late joins reconnect. Retained references remain fenced by their binding.
There is no transport generation cache: connection admission reads the head and
writer frames use the room binding. The retired-state-vector filter remains only
to identify cached pre-restore structs and deletes replayed by a reconnected client
on a current handle; it does not select or authorize a generation.
Persistence validates both under the document mutation lock and
drops stale bytes rather than relabeling them. An explicit stale checkpoint returns
`stale_generation`, never a successful checkpoint ID. Seed and compaction snapshots
are produced under that same lock. Current reads capture the head once and constrain
checkpoint selection, earliest retained-update selection, and replay to that identity
and generation. Sequence bounds do not authorize retired-generation history; only
explicit checkpoint lookup/listing and restore expose historical checkpoints.

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
A changed cut retries three times, then returns `deferred` at debug level and
remains stale for recovery. Serializer/database failures still log as errors.
Push completion requires a derived result inside its mutation transaction.

`document_derivations` certifies projection and link output by generation, next
admission sequence, location version, and extractor version. Equal cuts are
idempotent; older cuts cannot replace newer output. Projection byte size comes
from the same certified serialization. `document_links` is replaced in that
same transaction, using occurrences from the same private Y.Doc and the holder's
canonical URI captured under the journal lock. Rows are keyed by
`(source_document_id, link_key)`: `doc:<id>` and `asset:<id>` keys carry the
target id, `ahead:<uuid>` keys the ahead id and its decoded address, and a
contextual link keys by its href. It is a hint from a certified cut, never link
authority. Manifests (and already soft-deleted staged-push holders without a
live URI) certify with no link rows. Changing the extractor must bump its
version to invalidate older output; never add a second post-write publisher.

A certified derive whose rows hold `ahead:` refs registers the ones the registry
lacks (client mints): awaited when the derive runs outside a transaction (debounce,
move flush), after commit when it runs inside one (create, push completion),
because registration takes namespace keys in its own root transaction. A cut that
was already certified still registers, so an earlier failure retries. Registration
drains every page of the holder's refs. Failures are logged, never thrown; the
sweep and `flush` recover them by anti-join.

Nothing maintains links inside documents: a move or rename writes no bytes into
any holder, because links carry stable refs and re-spell on read. Draft
attribution normalizes live and branch journal entries to the package's
`ConcurrentUpdateOrigin` before block coverage. `system:reconcile` keeps neutral
`system` provenance: its bytes converge, but neither touched/deleted hashes nor
new lineage become human or agent echoes. Coverage projects the CRDT join of
baseline, upstream, and journal rows, since preflight can observe a live change
before the Work draft does; a recheck must not mistake that older upstream for a
new writer edit.

The recovery scheduler sweeps database staleness at startup and every ten seconds,
at most 100 stale documents returned per pass with a wraparound cursor. This
limits derivation work, not query scan work: an entirely current corpus is
scanned in full on every idle pass. Scoped `flush` pages all stale
documents in a project, or every project owned by `personalOwnerId`. Both ignore
caller transactions and timer queues. Failed derives log and retain last-good
output without advancing certification; a later sweep retries them. Then come
index ahead refs with no registry row (a failed client-mint registration does
not depend on the projection changing): `flush` drains every one in scope, so a
move finds them registered; each sweep attempts one page of 100 with its own
wraparound cursor, advanced by refs attempted rather than registered, so refs
that keep failing rotate through instead of starving the rest.

## Reference map

- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Branch model, provenance, manifests, and durable records](branch-model-and-records.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Draft/live visual model](draft-live-model.html)
- [Collab domain visual explainer, end to end](collab-domain.html)

## Stored link extraction

`domain/stored-link-extraction.ts` reads `{ kind, ref, href }` occurrences from a
live Yjs fragment: a link occurrence is a maximal run sharing one link mark (href,
title and ref) whatever other marks split it; a paragraph boundary ends a run.
Image and figure `src` attributes are occurrences with their own `ref`. Derive
(index rows and client-mint registration), the link scope's `prepare({ docs })`
and the view-revision digest share it. Nothing rewrites stored links.
