# collab — branch-backed document infrastructure

The server collab domain supplies concrete Postgres/Hocuspocus adapters around
`@meridian/agent-edit` and exposes `CollabDomain` to routes, runtime, context,
and WebSocket callers.

Model reads and writes go through `agentEdit()`, the thread-peer core pool,
with a destination per document (below). Open response records own their pinned
core participants independently of the resident-core cache. Invalidation visits
the deduplicated resident and response-pinned owners; residency eviction never
forgets an open reply. Idle-core protection derives from those response records,
not a second active-response index. First-write lookup, creation and enrollment
are synchronous before cache maintenance yields, so response close reaches the
owner and its existing lifecycle rejects resumed staging. A `live` destination selects the
live core and creates no Work draft or thread-peer branch: Auto-apply,
Auto-apply on No Work, and `scratch://` and `uploads://` in every mode. A
`draft` destination selects the thread-peer core; Draft on No Work uses the No Work
row's draft. A text branch is keyed `(documentId, draftId)`.

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
writes) and never touches a Work draft, kept or not; `draft` names its Work
and reads the thread view, its links spelled in that Work's view. A reply's staged writes overlay only reads of the destination they were
pinned to, so a live read never shows the reply's drafted edits. A thread rebind is resolved anew on each query. A draft read with no
thread peer flushes live into the shared Work draft and reads it; it never
creates a peer, so search stays read-only in branch topology while seeing the
state a later `read` forks from.

## Review authority

The review lives in the browser: the draft room projects `prosemirror` against its
server-owned `review_base` into changes (`projectReview` in
`@meridian/agent-edit/diff`). The server stores no change, token or evidence of its
own, and no read of the review needs a repeatable-read snapshot. What the server
answers is small:

- **Item metadata** (`GET …/documents/:documentId/draft?itemKey=`, `DraftItemMeta`)
  for every addressable item, listed or not: a text item carries its `roomName`,
  `isNew`, `wholeItem` and `hasChanges`; a branchless item (a created image or blank
  create) has no room and only item-level actions. A 200 means the item exists; a 404
  `gone` means it is closed. Read failures are HTTP errors, not a state.
- **The list** (`GET …/drafts`): the draft's tree state merged with its text
  branches by document, through the listed predicate (see
  [branch-model-and-records.md](branch-model-and-records.md#membership)). Each row
  carries the location token, the one freshness token left: a live rename, move or
  reveal between render and staging answers `stale`. Live text moving never refuses.
- **Commands** (see [settlement-and-trail.md](settlement-and-trail.md)): item Apply,
  Apply changes, Apply all, item Discard, Discard all, each under a `commandId`.
- **The attribution hint** and the chat strip's file list: see
  [Chat attribution](#chat-attribution).

Whole Discard and item Discard close branches only (the Discard kernel); the closed
branches' peers are retired after commit (`peer-retirement.ts`): their rooms close and
only their (document, thread) states bound to each returned peer branch are
invalidated, including response-pinned owners evicted from the resident cache. A
fresh peer in the same thread survives older retirement; pull contexts, lease epochs,
runtime replicas and staged mutation entries carry `peerBranchId`. Other Works' peers
and staged replies survive. Agent-edit offers `invalidateThreadDocument` for one pair
and `evictThread` for runtime eviction, never an empty-ID wildcard.

## One save per reply

The thread-peer pool is the only model read/write entry point. Each call
carries the `FileGrant` the caller got from `domains/file-policy`; its
destination routes the call. A write that commits now runs under
`runWithEditGrants`. Model inverse commands (`revert`) use the current destination grant
and immutable edit policy. A reply pins each document to its
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

Prepared response replay admits ordinary concurrent chat edits and writer deletions
as Yjs peers. A missing planning-visible item is not Discard evidence. Only removals
by immutable inverse edits after the helper cut revoke a staged write, and a write
that cannot integrate is dropped. The host reads inverse kind from immutable edit
origins, not actor or text similarity. Replay drops the whole logical write and its
later dependency closure, retains independent writes, and checks physical integration.
Its typed refusal evidence follows the write into notices and settled receipts.

## Write mode and drafts

A chat's write mode decides only where its new AI writes go (D62); chats in
one Work may differ. A draft write never pushes itself live (D59): a draft
that an auto-apply chat leaves behind, or another chat keeps writing, waits
there like a kept change, and the dock shows it. Switching a chat to
auto-apply touches no draft; Apply stays the writer's command. Branches carry no push
policy. Trail reconciliation consumes transactional dirty signals and never
publishes a draft. Active unapplied rows do not delay a terminal receipt.

## Pull and provisioning transactions

Effective reads, and therefore `DocumentRevisions.current`, may run inside a
caller's thread-locked or Work-locked command transaction. These rules keep
that safe:

- **Pulls commit on their own.** Live→Work-draft rebases
  (`domain/branch-pulls.ts` `run()`) and thread-peer content pulls run in root
  transactions outside any caller's ambient transaction. A shared pull promise
  therefore resolves only on committed state, and a caller's rollback cannot
  undo it. Pulls also leave the response transaction context, so root-committed
  cache updates and broadcasts cannot be deferred to an aborting response.
  Reruns and timer callbacks leave both initiating contexts. A live pull first
  lists the document's active Work-draft branches outside any transaction and
  stops when there are none; the list is read again, since one can close in
  between. It then rebases one branch at a time: the branch's lease first and its
  root transaction second (the save's order), the rebase reading live's certified
  cut from the journal and keeping the lease through the write. A thread-peer pull
  rebases the Work draft first, takes its live snapshot before opening its root
  transaction (the snapshot needs its own connection, and pulls that each hold one
  while waiting for another exhaust the pool and deadlock), then leases the peer and
  its upstream together so a Discard cannot close the upstream between capture and
  peer persistence. A peer never pulls from an upstream that closed while it waited
  for the leases.
- **Room loads read in the caller's transaction.** A room opened under a
  command transaction loads its journal snapshot and validates its handle's
  authority generation through that transaction. The transaction may already
  hold the authority head row from an admission, so a second connection would
  wait on it forever.
- **Joiners wait for the next run.** A caller that joins an in-flight live pull
  awaits one coalesced run that starts after its call. The in-flight snapshot
  may predate a writer edit the caller must observe.
- **Timers survive failure; failures are typed.** A rebase fenced by an unfinished
  settlement leaves a retry armed (the fence lifts on its own, but nothing else would
  pull again). A rebase that fails (`base_uninitialized`, `merge_failed`) fails the
  pull with a typed error, repeats on the same inputs, and is not retried: the next
  live write is the new input. A fired handle is cleared so the next update re-arms
  the maximum bound, and a cancel records an epoch so an in-flight pull never rearms
  its timer after shutdown. Background failures go to
  `BranchPullDiagnostics.backgroundFailed`.
- **Provisioning splits authority from infrastructure.**
  `ensureThreadPeerBranch` takes the canonical thread row lock in the caller's
  (or its own enclosing) transaction, then commits the text branch and thread
  peer in a root transaction. It never ensures a draft: the draft is held
  `FOR SHARE` while the branches are made, so a close either waits for the commit or
  has already closed it (the peer is then stale), and it locks no Work row. The root
  must not relock the thread row, since the caller may already hold it. It resolves
  committed Work membership, not a caller's uncommitted rebind. Callers release
  live/branch access before taking the thread lock (they pass detached snapshots);
  pull callbacks never take it.
- **FK references must not wait on the caller's locks.** A root insert that
  references a row the caller locked waits on a transaction that is itself
  awaiting the root in JavaScript; Postgres never detects that cycle. Work
  lifecycle and thread locks therefore use `NO KEY UPDATE`, which admits FK
  `KEY SHARE`. Authored branch mutations (`commitBranchMutation`) still take the
  Work lifecycle lock. Rebase and pull writes use the lock-free
  `updateBranchSnapshot` (still the one `writeBranchState` underneath), because
  replication creates no reviewable edit.

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

A checkpoint's state must contain every row at or below its `up_to_seq`; a cold
load never replays those rows. Seed, room and explicit checkpoints therefore
persist only a `CapturedCheckpointCut`, never a free state/watermark pair and
never the warm room's bytes (a writer row can be durable before Hocuspocus applies
it). See the [checkpoint capture decision][checkpoint-capture].

- **Minting.** Only the journal adapters mint a cut
  (`adapters/drizzle-checkpoint-capture.ts`, the in-memory journal). The type is
  nominal, so a spread copy does not type-check, and persistence resolves the
  payload through an adapter-private identity registry, so a forged or cloned
  object fails at runtime too. Do not add a raw constructor. Agent-edit's generic
  journal port does not produce checkpoints; compaction remains host-owned.
- **Capture is short.** Under the mutation lock, the single-statement
  `capture_document_checkpoint_range` SQL function records the generation's base
  checkpoint ID and the closed suffix range, reading no bytes. Its exception
  subtransaction releases the locks it took even inside an ambient transaction;
  caller-owned locks stay with the caller. Keep it one statement: a client
  savepoint spanning awaits can roll back sibling statements queued on the same
  connection.
- **Materialization is unlocked.** Persistence replays base plus suffix before
  taking its own lock, yielding between replay batches. Base hydration and final
  encoding remain synchronous Yjs work.
- **Persistence revalidates under lock.** It rechecks authority generation and
  input retention, even for an already materialized cut. Explicit persistence
  joins its caller's transaction, so it never waits on itself through a second
  connection.
- **Retention is `retired_through_seq`.** Every compaction, including one that
  folds nothing because an ordinary checkpoint already covers the prefix, raises
  the head's generation-local `retired_through_seq` in its delete transaction.
  Generation replacement resets it. A cut whose suffix floor is below it is
  rejected; the room worker emits `checkpoint.failed` and the next store
  recaptures. Never infer retention from checkpoint `reason`. Document cascade
  removes the head and invalidates its cuts.
- **Attribution is still slow.** Writing the checkpoint row rebuilds attribution
  from all retained rows under the mutation lock, with quadratic range
  accumulation ([#805][issue-805]).

[checkpoint-capture]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/journal/checkpoint-capture-from-journal.md
[issue-805]: https://github.com/haowjy/meridian-flow/issues/805

The derivation store captures checkpoint plus current-generation journal under the document
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
authority. Already soft-deleted staged-push holders without a live URI certify with
no link rows. Changing the extractor must bump its
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
- [Branch model, membership, provenance, and durable records](branch-model-and-records.md)
- [Reversal (revert and rollback)](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Draft/live visual model](draft-live-model.html)
- [Collab domain visual explainer, end to end](collab-domain.html)

## Stored link extraction

Markup's `stored-links.ts` (`extractStoredLinks`) reads `{ kind, ref, href }` occurrences from a
live Yjs fragment: a link occurrence is a maximal run sharing one link mark (href,
title and ref) whatever other marks split it; a paragraph boundary ends a run.
Image and figure `src` attributes are occurrences with their own `ref`. Derive
(index rows and client-mint registration), the link scope's `prepare({ docs })`
and the view-revision digest share it. It is the Yjs twin of
`walkLinkOccurrences`, which ref assignment walks; a parity row in agent-edit's
`assign-refs.test.ts` pins the two to the same sequence. Nothing rewrites stored links.
### Chat attribution

`GET …/documents/:documentId/draft/attribution?itemKey=` returns the AI edit parts
pending in the item's text branch (`DraftAttribution`): per edit the thread id and
title, turn id, time, and the item ranges it inserted and deleted. The browser
matches those ranges against the room to name chats on changes, and the chat strip
(`GET /api/threads/:threadId/draft-files`) lists the listed items whose pending AI
edits, or whose creation, belong to the thread. It is a hint: nothing gates on it,
and writer edits are never listed. A branchless item has no text and so no edits.
The application service collects journal thread ids and resolves titles with one
batched lookup, never one query per edit.

### Live writes versus CLI replacement

Live writer SET and agent writes routed to live never touch a pending Work draft:
the next rebase merges the live edit into the draft by content, keeping every draft
change. `./mf doc put --overwrite` is not this path: it deletes the document and
creates a new one at the same URI, and the new identity inherits no drafts.

### Draft agent writes

Draft agent writes preserve unchanged words and journal each paragraph of a logical
write under a fresh client. Recognized adjacent split/merge boundaries and
contiguous inserted or removed block runs form one structural segment. Each segment
is one transaction and one row; all rows of a reply publish atomically. Sharing a
paragraph never joins independent writes. Edits inside pending inserted text join
that insertion.

### Block alignment and difference

`domain/document-difference.ts` owns block alignment and identity-aware semantic
changes with the clock ranges each block change supplied or removed;
`domain/document-content.ts` owns the canonical rich content it compares
(`documentProseEqual`: text, marks, node types, attributes and ordered children,
ignoring Yjs history and attribute-object prototypes). Publication consumes the raw
difference directly: the trail carries explicit before/after canonical block
identities, and display hashes and serialized prose never supply identity. The
review's own difference (what the writer sees as red and green) is the browser's
projection, not this module.

### Selective response replay

Buffered draft helpers are private to agent-edit's response committer, never
runtime-store replicas. Every tool and scoped content read obtains a prepare
lease; effective readers prepare before taking their branch-read lock. Peer
pulls cannot reconstruct or merge into the owned helper. Reporting uses
disposable replicas, and only tool results drain dropped-write notices.
Rollback defers disposal until transaction commit; abort keeps the view intact.

A staged write is refused only on inverse evidence or a failed integration; text
that merely disappeared (a writer's local Discard, a rebase) merges like any peer's
edit and, when it landed in discarded text, raises the invisible-write notice.
Responses replay staged segment rows onto the current text branch under the
existing branch lock, then check integration (`branch-response-replay.ts`). A write
that cannot integrate, and its later dependent logical writes, are dropped
atomically per write; independent writes commit. The helper is replaced with the
current branch plus surviving stages before subsequent tool resolution. Dropped
writes are named once per document/handle in the next tool result, with partial
versus whole rejection distinguished; their save receipts use the existing
per-result failure path. Discard does not roll the reply back: its peer retirement
drops only that thread's staged writes on the discarded draft's peer
(`discarded_draft`, `discarded_document` or `discarded_edit`), and the reply's other
documents still commit. No settlement deferral or second retirement state machine
exists.
