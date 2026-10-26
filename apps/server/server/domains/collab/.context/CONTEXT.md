# collab — draft-backed document infrastructure

This page records the contracts that cross collab's Yjs, persistence, review,
and transport boundaries. The focused pages hold draft vocabulary, authority,
reversal, committed trail, and WebSocket details; this page keeps their shared rules.

## Boundary and destinations

`CollabDomain` supplies Postgres/Hocuspocus adapters around
`@meridian/agent-edit`. Model reads and writes enter through the thread-peer
pool and carry an explicit destination. A `live` destination uses the live
core and creates no Work draft or thread peer; a `draft` destination uses the
thread-peer core and names its Work. Scratch and upload content is always live;
their placement can still be a Work branch fact.

A reply may hold a live core and a thread core at once. Staged writes overlay
only reads of the destination to which they were pinned. A live read never
shows staged draft content. Rebinding is resolved again for each query; a
read-only draft query without a peer may rebase live content into the shared Work draft,
but does not create a peer.

The composition root wires required services and provider ports. It owns no
business behavior, mutable runtime state, or optional capability matrix.
`collab-facade.ts` only assembles the domain surface. Agent-edit owns the
memory-only mutation kernel; collab owns authorization, persistence,
coordination and trail projection.

## Draft review admission and Apply clicks

`domain/provenance.ts` declares `SERVER_OWNED_ROOTS`: `review_base` and
`__meridian_review_applied_v1`. Writer and agent admission rejects insertion
into these roots and new deletion of their live items. Repeated tombstones are
not a new deletion. The per-document namespace cache invalidates when protected
roots change; deletion checks read current item flags. Provenance roots retain
their existing stricter admission, including live's repeated-delete refusal.

`finalizeAppend` judges incoming writer and agent rows under the draft row hold.
Server rows bypass both writer authorship and agent freshness checks. Restoration
records in `__meridian_review_restored_v1` are writer-writable and checked only
for integer, non-overlapping link and known-range bounds after integration;
content kinds and tombstone text never certify them. Browser restoration
certificates are not written into journal metadata.

Apply has one HTTP door per document: `draft/apply`. It compiles the frozen
snapshot off-lock, then commits live, the prefix-authored review base and Apply
record, lineage, trail and terminal command outcome atomically. A stored result
wins over every fresh refusal, including a retry after close. See [Apply](apply.md)
for the storage boundary and diagnostic timing contract. Work Apply all is a
browser loop of per-document clicks; there is no settlement executor or recovery
worker behind the route.

The server has no preview route and no review-cut, attribution or selection engine; review is computed in the browser.
The SQL-only addressed metadata GET resolves active drafts even when unlisted;
it returns the stable room name without loading that room. Browser provenance reads use `domain/draft-provenance.ts`
over the disposition store's repeatable-read capture, without a server diff.
The route checks project/Work and draft-file read authority, then verifies the
captured draft belongs to that document and Work. It returns snapshot bytes
and owner-rolled AI ranges; current single-user projects never query human
receipts, even when unresolved ranges were requested. The receipt query starts
with the document's agent edits (partial actor index) and joins parts by edit
and immutable origin draft, so human typing history need not be scanned. Edited-text Discard belongs to the browser's local undoable edit.
The per-document HTTP Discard can only end a still-hidden creation's branch use;
a creation revealed before its locks answers `stale`, without changing text or
claiming a command. Work Discard all and purge keep the shared close/end-use kernel.

## Revision and review authority

`domain/document-revision.ts` produces a revision from the encoded Yjs
snapshot, holder URI, and sorted stored-link/image identities. It must include
both the delete set and the holder's link spelling: a state vector misses
pure deletion and a document snapshot misses tree-only moves. Reads and applies
compute the token synchronously in their prepared link scope; an unverified
recovery returns `null`, never a later read's token.

Hidden-creation Discard closes its addressed drafts and peers; Work Discard
all closes the branch. Edited-text Discard closes no server peer. Thread-core
invalidation follows committed close retirement.

Every draft ends through one close, `DraftClose.closeDrafts(tx, selection,
cause)` (`adapters/drizzle-draft-close.ts`), with `cause` one of
`branch_closed`, `document_discarded`, `edit_discarded` or
`{ documentRemoved: record }`. It prelocks Work drafts in ID order, then thread
peers in ID order, derives the durable
`closed_cause` (`document_removed` for a removal, else `discarded`), and joins the root transaction's
retirement batch (a transaction participant: a rolled-back savepoint's closes
leave with it). After the root commits the batch retires once
(`domain/draft-retirement.ts`): a draft whose document the same transaction
removed retires as a removal whatever its own cause (its rooms close `4208`,
its peers' staged writes are refused `{ removed: record }`), so a Discard that
closes a created document's drafts and then tombstones it still closes their
rooms `4208`; any other closed draft's room closes stale and its peers are
refused with their cause's `discarded_*` reason. Every removal registers its
documents with the batch (`DraftClose.registerRemoved`); only a discard also
closes their drafts. A live delete closes no draft (D79): the drafts stay
ordinary active drafts and their rooms stay open. A removed document's live
rooms close `4208`, but only while the
removal still stands: after every matching room load settles, one batched record
read outside DB locks drops live rooms a Work Restore has since made living
again (draft rooms close by exact draft id; a closed draft stays closed). A
Restore that commits while that read is in flight can still have its new live
connection closed `4208`; the app's stale-4208 recovery reconnects it. Why a
reply's closed pin lost its write is one pure rule, `closedPinReason`
(`domain/closed-pin-reason.ts`), shared by the save fence and a failed peer
identity ensure: a draft closed `document_removed` is the removal's even when its document
stands again (`removed: null`). The closer is
built at the composition root and its retirement bound by the collab domain once
rooms and cores exist (the `hocuspocusBinding.current()` pattern); unbound, as in
fixtures without rooms, it retires nothing. A caller whose commit happens inside
process-level live scopes (Discard) runs under `holdRetirement`, so retirement,
and a save racing it, never wait on scopes the committer still holds.
Retraction takes the same lock order before checking for other contributions
and closes rather than deleting. Removed documents refuse new Work drafts under
their document mutation lock, after Work/thread and branch admission; an
existing active Work draft is returned whatever the document's state, and a
thread peer forks one that outlived a live delete (`requireDraftableDocument`).

Only a committed removal closes live sockets with `4208`, and the draft sockets
of the drafts it closed (a discard's). The room
helper closes the gateway transport before Hocuspocus's protocol close, which
otherwise arrives as `1000`. Failures are logged as
`collab.retirement.after_commit.failed`.

A discarded document's closed draft rows remain as lifecycle records, but their
journals are deleted and `state`/`state_vector` are zero-length bytea.
Zero-length state is deliberately
invalid Yjs: `readDraftAt` omits its checkpoint and `materializeDraftRead`
rejects it, including a raw zero-length checkpoint. It is never an empty document.
A `deleted` removal retains all bytes and closes no draft, so restoring the
document finds its drafts as they were.

## Review identity and enrichment

`branch-review-identity.ts` resolves through metadata-only `reviewItems.resolve`: active
draft metadata and tree/existence facts. `reviewItems.list` enriches only listed
items with receipt-based chat membership. Addressed metadata and Apply grant
selection never materialize or classify current text; text Apply classifies its
frozen clicked cut only.

## Historical draft disposition

`domain/draft-disposition.ts` is the read-only receipt view for PR B's two-fragment
review. `createDraftDispositionReader` consumes `DraftDispositionStore.capture`;
`adapters/drizzle-draft-disposition.ts` captures bytes, revision, project owner
and AI receipts in one root repeatable-read transaction, with no room reads,
live merge, provisioning or write admission. Inverse planning, immutable turn targets and pending owner membership consume this reader.
Do not reuse active-only `ReadReviewCut` for historical disposition.

Receipt selection is `document_edit_parts.origin->>'draftId' = $draftId`,
joined to `document_edits.actor = 'agent'`, latest first. The partial index
`document_edit_parts_pending_origin_idx` covers that origin expression (not placement). No generation filter applies.
The part array keeps numeric receipt IDs and `editId`/`ordinal`; classification
members index that same array. Conversation identity and reveal links roll
subagents up to their nearest primary ancestor. Receipts survive deletion of their
thread or turn; unavailable identity yields no byline, not missing membership.
`provenance.parts[].status` is Apply evidence only; final status is
`parts[].disposition` (non-applied parts can be discarded).

Apply-record overlap wins, including birth recovered through validated Undo
links. A receipt may have both applied and pending portions: any applied
footprint makes its coarse disposition applied, while classifications still
expose pending membership independently. Without Apply evidence an active part
is pending only if some change includes it, otherwise discarded. A retained
closed draft checks Apply evidence first; its other parts are discarded.
Released closed bytes yield null provenance/projection and all discarded, never
an empty document. Removed-document precedence remains the caller's concern.

`writerRanges` is the optional clock-range request. All projects currently have
one `projects.user_id`, so this adapter never queries human receipt history and
omits `writers` even when requested. A multi-user project model must supply
bounded writer evidence and its kernel naming before enabling that mode.

## Save, replay, and grants

The thread-peer pool is the only model document entry point. Each call carries
the caller's `FileGrant`; writes run under the grant scope and a reply pins a
document to its first grant. The response transaction saves all live and draft
journals, receipt records, and callbacks together. Live rooms receive writes only
after commit, so rollback is invisible to open editors.

A chat's write mode decides only where its new AI writes go; chats in
one Work may differ. A draft write never pushes itself live: a draft
that an auto-apply chat leaves behind, or another chat keeps writing, waits
there like a kept change, and the dock shows it. Switching a chat to
auto-apply touches no draft; Apply stays the writer's command. Drafts carry
no push policy. Trail reconciliation consumes transactional dirty signals and
never applies a draft. Active unapplied rows do not delay a terminal receipt.

A reply's save resolves exactly the peer each document was pinned to and
refuses that document stale when the pin no longer holds (closed peer or
closed draft, closed branch). Peers are created only by the identity ensure for a tool access, never by a save.

Save confirms every grant used by the reply once, drops writes whose Work lost
access, and marks the remaining writes for the journal's no-grant guard. A write into a room where the model has no frontier plans on the current room.
A write with a usable frontier plans on that offline view and merges onto the
current room. Model inverse commands use the current destination grant and
the immutable edit policy, not a legacy journal selection.

Every model call reads its room fresh through agent-edit's `readRoom`. The
draft adapter (`domain/draft-agent-edit.ts`) runs the live→Work rebase, copies
the Work draft replica and reconciles the edit scope's staged entries against
the scope's first-stage snapshot cut; entries an earlier, now closed peer of
the scope accepted are refused with the Discard's reason. The live adapter
(`adapters/hocuspocus-coordinator.ts` `liveRoomCopy`) reads the journal and
the room without the document mutex. A room is named from what was read:
`draft:<workDraftId>` (never the peer id or the generation) or
`live:<documentId>:<authorityGeneration>` from the copy's bound authority
(`domain/observation-rooms.ts`). The effective reader reads through the same
door and the same route: the pool's `routeRead` serves the tool read and
`readRoom` alike. The reply's pinned participant wins with its edit scope (so a
live read keeps the reply's staged live writes); an explicit live read never
takes a draft pin; otherwise a draft read goes to the thread's core when the
thread has a Work draft of the document, else live.

A call whose caller passes `frontiers` (the read and write tools, and
reference reads, which pass `recording` only) records an observation frontier
in the room its result rendered from. A write plans on the `planning` lookup
when usable, otherwise on the current room; neither path refuses concurrent text.
An undo, redo or revert records in the room its inverse committed into
(`DocumentEditResult.room`). A staged write records nothing. The reply's save,
given `recordingFrontier`, records each saved document in the room the save
committed into (the draft adapter's `prepareSave` room, or the live room under
the save's lock) at the save's after-state. `format: "edits"` reads record none.
See [runtime document text](../../runtime/.context/document-text.md#observation-frontiers).

A draft-mode access whose bound peer a Discard took is named, not failed:
`peerLossReason` (`domain/draft-pulls.ts`) classifies it in the save fence's
precedence (closed branch, then closed Work draft, then closed peer), and the
draft adapter throws agent-edit's `DocumentAccessLostError(reason)`, which the
write's result carries as the same refusal its save receipt would.

Prepared replay treats ordinary concurrent chat edits and writer deletions as
Yjs peers. A planning-visible item disappearing is not by itself rollback
evidence. Only immutable inverse removals after
the scope snapshot cut revoke a staged write. Replay drops the rejected logical write
and its later dependency closure, retains independent writes, and reports the
typed refusal in notices and receipts.

## Work mode and draft persistence

Work write mode chooses the destination for new AI writes. A draft write never
pushes itself live, even if the Work changes to Auto-apply while the reply is
in flight. Switching to Auto-apply with pending changes explicitly chooses
`apply` or `keep`; draft data does not carry push policy. Applying an archived
Work refuses under the Work lock.

Live writer SET and agent writes routed to live preserve a pending Work draft:
pulls merge live edits into it without settling its authored rows. `./mf doc put --overwrite` is not that path: it deletes the
document and creates a new one at the same URI, and the new identity inherits
no drafts.

A Work draft is shared by every thread editing the same document in that Work.
Thread peers retain their upstream draft identity for binding and retirement, but perform
no content pull, catch-up or write. There is no draft reset or peer re-fork.

Attribution is based on immutable journal provenance and dependency closure,
not text similarity or block proximity. Writer rows retain their identity.
Independent deleting edits remain independent when their insertion clients are
different; cumulative delete ranges from retained rows still participate when
they are genuine dependencies. Agent writes use fresh writer clients and
journal their own transaction deltas. Recognized adjacent structural runs may
share a segment, but sharing a paragraph alone never joins edits.

## Transaction and lock contracts

A new draft write makes four choices, each named below: its door (an append,
an exact or fold rewrite, or the metadata door), its Work admission (`active`
or `any`), its entry into the Works mutation boundary (every write except an
append, which locks no Work), and its bounded attempt (an append has one).
It takes no other lock and adds no retry loop of its own. No write compares
bytes.

An **append** (`appendRows`) is sequenced, not fenced. Its row `UPDATE`
bumps `revision` at whatever value it holds, with no revision predicate, and
holds the draft row to `COMMIT`; it still refuses a closed draft or a Work that is not active (the predicate is in the statement).
Journal ids are allocated after that lock, so within a draft a
lower id is committed before a higher one is visible (tail order): a fold's
`checkpoint_seq = max(id)` is always a complete prefix. Under the lock one
separate statement reads the committed prefix since the caller's base, and
`finalizeAppend` (`domain/draft-receipts.ts`) owns every fact that depends on
it: containment, the novel trim (`Y.diffUpdate`), deletes the prefix already
held, restoration id-range bounds, writer/agent admission on the committed prefix, complete
integration, and one receipt per logical write on the final document. An
update with nothing novel is `contained` (nothing written, acknowledged); one
whose prefix the journal lacks is `prefixMissing` (nothing written, the socket
closes `4207 draft-prefix-missing`, which the client treats as a reconnect,
never a refusal; its next SyncStep2 carries the prefix). `appendRows` runs in
its own savepoint, so either outcome rolls its bump and its commit callbacks
back inside a reply's transaction too. Nothing judged before the lock is
written as truth: the frame's pre-lock containment and authorship checks are
early exits only. `waitMs` and `holdMs` of every append are the
`collab.draft` `append_committed` debug event. The hold (about 6 ms at the
median) includes the change-trail triggers that fire on each journal and
receipt insert, three per keystroke; a slower trigger or `change_trail_owners`
query there is keystroke latency for every writer on the draft (see
[change-trail.md](change-trail.md)).

Every rewrite is fenced by the row's `revision`, under one of two policies.
An **exact** rewrite commits only at the revision it was computed at: a
checkpoint rewrite at an inverse's destination. A miss surfaces as `DraftCasConflictError`, and the attempt
captures again. Close locks active draft rows in ID order, writes only their
closed status and cause, and bumps revision; it does not settle receipts or
journal statuses. `rollback_pending` remains a journal diagnostic, not part
disposition. A **fold** (compaction) commits over the replica's
cursor instead: rows appended since it was computed are applied into its
checkpoint under the row lock, so an intervening append never makes it miss,
and only another rewrite does. Whether a draft is frozen is derived on every
read from its branch's origin Work (archived, deleted, or missing), never
stored. Archive and restore lock no draft row and bump no revision (Work deletion also
removes its owned documents through the tree removal protocol; a `deleted` removal leaves their drafts active):
every rewrite and reply save locks the Work through the Works
mutation boundary below and orders itself against the transition, and the
append keeps the Work predicate in its `UPDATE`. That predicate keeps its
statement's snapshot, so an `UPDATE` that started before an Archive committed,
including one queued behind another holder of the row for seconds, still takes
the row; the post-lock read runs in a fresh snapshot and refuses it. What lands
in the archived draft is a frame whose post-lock read ran before Archive
committed and whose `COMMIT` came after: the finalization phases and inserts, a
few milliseconds, independent of how long the frame waited for the row. Every
later key is refused and shown as not saved; unarchive admits the next. This
archive window is accepted rather than a lock on every keystroke (probe
`archive-in-flight-append`); do not close it with a lifecycle revision bump or
a Work lock on the append.

Work-first order has one owner: the Works mutation boundary
(`projects/adapters/work-projection-mutation.ts`), a required dependency of the
draft store and of every collab store that writes branch or draft rows. It
locks the Works a write names, directly or through its branches and drafts,
`FOR NO KEY UPDATE` in id order, in the caller's transaction, before any branch,
inverse, document or draft lock, so every write enters Work, branch, document,
draft, the order the transitions take. A caller hands it its whole write set
once, through `lockWorks` (opening a branch, Apply's batch plan, a reply save's
grants) or `mutate`, which is `lockWorks` then the write. Every Work locked
either way has its stored pending count reconciled at commit, and only a Work
whose count moved is notified (one SQL aggregate over the transaction's locked Works;
`projects/.context/CONTEXT.md`). `seam` adds the bound edit
grants' Works and confirms the grants; `requireActive` refuses unless every
Work of the set is active. No other collab code locks a Work for a write; the
live journal's seam locks only the bound grants' Works. Creating a document draft
runs inside `mutate`: a draft made while its Work archives waits on
the Work row and is read as archived once the archive commits. No append enters the boundary: no
keystroke locks a Work or counts. Tests use the same boundary
(`apps/server/server/test-support/work-projection.ts`), with no catalog or
availability notice.

A work draft's derived state (`has_effect`, its review membership, the Work's
badge) is a projection, not part of the append. Every committed
append marks the draft dirty (`onAppendCommitted`, a required coordinator
input); the projection job (`domain/draft-projection.ts`) coalesces marks
(250 ms after the last, at most 1 s after the first), runs at most four
judgements at a time, compares `review_base` and `prosemirror` with the kernel's
`blocksEqual` (empty fragment equals one default empty paragraph), and writes `has_effect` with its watermark `has_effect_revision` through
`writeEffect` at exactly that revision, inside `mutate` (which reconciles the
Work's stored badge count and notifies only if it moved), under
`SET LOCAL lock_timeout = '100ms'`. That bound applies to each lock
acquisition (the Work, the draft row, the Works-notice participants), not to
the transaction; `55P03` is `contended` and retried on backoff, a moved revision
is re-judged at once, so the badge converges within the max wait once typing
pauses and eventually while typing. That is the contract, not a bound to
tighten: the job's write must never bump `revision`, and the badge must not move back onto the append. Every writer of `has_effect` (the seed or projection job) writes the watermark with it; `-1` is stale
whatever the revision. A sweep (the `draft-effects` recovery lane, every 30 s)
pages the stale set by `(updated_at, id)` and marks what no entry tracks, so a
crash inside the debounce converges without another key. Review readers
(`isEdited` and the Works badge) may lag a key by that second;
the draft editor and Undo read the replica and receipts, never `has_effect`.
Tests that assert membership right after a write read through
`test-support/converged-review.ts`, which flushes the job first.

New drafts use `seedDraftState`: live's blocks written twice as fresh client-1
items into `prosemirror` and `review_base`, equal at revision 0, with no
`live_cut`. Migrations 0075–0081 convert existing drafts restartably, then drop
the retired baseline and settlement storage. There is no null-baseline repair
arm or fingerprint cache in the runtime.

A writer frame takes no lease, mutex or document lock. It is judged once on the
committed replica (admissible, its room, the echo exit, authorship as an early
rejection) and appended once; a concurrent writer costs it one row-lock wait,
never a second judgement. It first checks its room holds the committed replica,
and a room that does not has missed a delivery: it is reconciled to the replica
(`reconcileRoom`, logged as a `room_reconciled` warning) and the frame goes on.
A closed draft refuses with terminal `4205` (`discarded`), or removal `4208`.
An inactive Work refuses without ending the draft (`4409`).

Room delivery has one owner: `install` in
`domain/draft-runtime.ts`, the only place a replica becomes the draft's
committed replica. It runs when the store's transaction commits (a savepoint's
callbacks move to its parent on release and are dropped on its rollback, so a
rolled-back child installs nothing), installs only past the replica installed
by then, and sends this process's rooms what separates the two: the rows the new
replica was built from when they cover everything past the installed one (built
on it or on an older replica of the same checkpoint: a frame with
the rows that landed before its lock, a reply's rows, a read's tail catch-up),
otherwise the document difference (a compaction that folded rows under the draft
lock, or a checkpoint another process wrote), or nothing when the content is unchanged. A transition at or below
the committed revision installs and sends nothing, so a read racing a local
commit delivers once. `install` reaches only rooms Hocuspocus has registered,
and Hocuspocus 4.3 registers a room only after its load hooks return, so a room
enrolls itself: its `afterLoadDocument` hook chains after
Hocuspocus's own registration, and the coordinator's `reconcileRegisteredRoom`
reads the draft and reconciles the room to it, or closes the room when the
draft closed while it loaded. From registration on, every
transition reaches it; enrollment covers what committed between its load read
and registration. The load and draft `connected` hook re-check active status. Rooms are Yjs replicas kept current by anti-entropy ([eventual
consistency][eventual]):
push delivery is the fast path, and the room is reconciled against the
committed replica (structs past its state vector plus the delete set) at every
exchange that reads the draft: its enrollment, every tab's SyncStep1 handshake
(the same `reconcileRegisteredRoom`, before Hocuspocus answers the tab, whether
the tab may write or only read), and a frame that finds its room behind. A room
that missed a delivery, or another server process's commit, therefore heals on
the next exchange and is never refused for it; the tab's own Yjs handshake then
brings the tab current. `1008` remains a nonterminal admission error; closed identity is terminal. Another process's
commits also reach this process's rooms when its runtime reads the draft for a
turn inverse's `deliverCommitted`. There is no periodic reconciliation: an idle
room with no exchange catches up at the next keystroke, rejoin or handshake.
Every committed append (writer, agent or server) schedules a background tail fold at
512 rows or 2 MiB (`compact`: no content, effect or `updatedAt` change).
`domain/draft-runtime.ts` owns committed replicas, prefix materialization, prepared
append/rewrite ownership, monotonic installation/delivery and maintenance. Its
`compacting` set keeps one fold per draft in this process. A rewrite that wins
first makes the fold miss; the next append past the bound tries again. Failure
is logged as `collab.draft` `compaction.failed`. Neither maintenance nor dirty
signaling runs before the root commit, even when a prepared append's savepoint
has released. `domain/draft-coordinator.ts` owns read and staged-save operation policy; `domain/draft-writer-frames.ts` owns writer admission.

The shared `prepareAppend(base, rows, { admitted?, authorServerRows?, precondition? })` prepares
no server bytes before the lock. `finalizeAppend` first materializes the committed
prefix, judges the save's optional precondition, then admits incoming rows. The optional async-capable author receives a
private gc-off copy of that post-row prefix, with client 1 set, and returns its
captured transaction updates in order. Each is admitted on the receipt before-view
as a separate `source: server` journal row and receipt. The authoring copy is
needed only for server operations; ordinary typing adds no copy under the hold.
Zero updates are contained when no incoming row is novel. A thrown author aborts
the same append. The same finalization captures the save's before/after cut under the row hold,
including the unchanged prefix for a contained append. There is no second save
read and no rebase- or Apply-specific persistence/install door.
`drizzle-draft-storage.ts` still owns storage primitives; `drizzle-drafts.ts`
wraps them with receipt persistence and savepoint rollback.

Finalized immutable documents share one lazy encoding through
`immutable-draft-state.ts`, weakly keyed by the document. Save cuts retain before
bytes and the final document, never an append callback or its previous replica;
the replica itself owns no encoding accessor.

Every draft write runs through `runBoundedAttempts`
(`domain/draft-attempts.ts`), the one owner of a candidate's lifetime: capture
and compute off every lock, one commit scope per attempt (a root transaction,
or one savepoint inside an ambient one) opened before its first draft-store
lock, and a miss that leaves that scope before the next capture. The attempt
owns its candidates: a completed attempt transfers them to installation, and any
unwind disposes the rest, including a write whose own statement succeeded in a
scope a later miss rolled back. An append (a frame, a reply's rows, a content rebase or an Apply review-base update) is one
attempt and never retries; exact and fold rewrites recapture on a miss. The bound's exhaustion outcome stays with each caller.

A reply save is an attempt across every participating core: prepare
reconciles each staged document on a candidate of its Work draft, consume
appends per upstream inside one savepoint, install delivers. A miss unwinds the
savepoint and prepares again from the original staged buffer, up to four
attempts; the reply's `confirm` runs once, and an attempt prepared before it is
disposed if it throws. The save and a thread core's tool-time reads hold no
draft: they go through the coordinator's `copyDraft` and `prepareStagedRows`,
which read committed replicas and read the journal through one
`DraftReplayJournalReads` port. The reply's rows reach each Work draft as a
sequenced append, like a frame's, and never miss on a revision; a peer takes
no rows. The confirmation is
the retained exception: it runs once, outside the save attempt, and holds
its Work rows and branch-row and live advisory locks across attempts 2 to 4; only
draft rows release on the savepoint rollback. A reply's draft rows are sequenced under the row hold; a revision change does not
make that append retry.

An inverse (Undo, Redo, revert, rollback, and the model's `undo`/`redo`)
captures without any lock: one read-only snapshot of each document's live
head, each committed draft at its revision without merging live identity, the
history and each draft's lifecycle. It plans on that capture, then commits in
one scope: the live mutexes of its live destinations, then a seam boundary
(`mutate` with `seam`): the captured drafts' Works and the bound
grants' Works in id order, the grants confirmed, before any other lock (a
live-only inverse such as a named Work's Scratch reaches its Work only as a
grant Work). Tree inverses use the context domain's shared tree-edit admission;
the inverse still owns retry so a moved tree scope causes a complete recapture.
Then its documents' mutation locks in id order,
the live head check, and each draft destination's exact checkpoint rewrite at
its captured revision. Those captured fences, not a lock of the inverse's own,
order two inverses of the same edit: the second misses, recaptures and finds
the edit already reversed (probe `d22-concurrent-undo` in
[the lock-free probe index](../../../../../../docs/qa/drafts-lock-free-probes.md)). Any moved revision or head unwinds the attempt and
recaptures; after four attempts one more capture is classified without
writing, so a plan that still applies is a `ReversalConflictError`, never a
semantic refusal. Historical disposition reads include closed drafts; the
active planning capture remains the only source of write admission.

A live commit schedules a content rebase (2 s debounce, 10 s maximum). Off-lock,
the service reads committed live and skips drafts whose base already matches.
Under the draft row hold its async append author re-reads committed live through
the live journal's single-statement authority/checkpoint/tail read, rematerializing
it fully rather than caching an incremental cut. It calls `rebase(base, live, draft)`
and writes both fragments in one client-1 transaction, one `source: server` row.
It takes neither a live lock nor a Work boundary, capture or revision predicate;
background rebases keep archived drafts current. Server append events include
`holdMs` and `serverRows` for measuring hold time.

Writer and agent admission runs `findLostEdits` against the committed prefix.
Only hidden typing under a top-level block whose deletion is certified by a
server row's immutable receipt is recovered. Receipt reads happen only for
hidden typing, selected by block id. Recovery authors another client-1 server row
in the same append; its opaque per-draft `LateTyping` memory installs only after
commit. Deletion-only frames advance memory without writing; a contained echo with
existing recovery observes its deleted separators without a row hold. Deferred
observers read latest memory at commit, and finalizers retain observations made
during receipt I/O (`retainLateTypingDeletions` keeps the kernel's memory bound). stale backspaces
never remove recovered writing. Another writer's deleted block is not recovered.

Thread peers have no content jobs: no pull, exact catch-up checkpoint or peer-bound
write. Identity provisioning and exact peer retirement remain for Track M4.

Room loads read in the caller's transaction because that transaction may
already hold the authority head. Provisioning locks the canonical thread row
before committing the peer in a root transaction (a Work draft it needs
commits first, in its own Work-first root), and the root must not re-lock that
thread. Referenced rows must be committed before a root
peer can reference them, so manifest identity and its live head commit in a
root transaction. Live manifest writes instead load the manifest in the
caller's transaction: during cold project bootstrap the project and source are
uncommitted and must roll back together, and no such path provisions a root
peer. Use `NO KEY UPDATE` where a root insert needs FK key
share against a caller-held lifecycle lock.

The lock order is one list, and every path takes a prefix-ordered subset of it:
live `withDocument` mutexes (sorted) before any transaction, then inside the
database Work rows (only through the Works mutation boundary), the branch row,
sorted namespace and advisory keys (`lockDocumentMutation`'s document keys in
ID order), then draft rows, an
upstream before its peer, otherwise ID order. No path takes a Work row, a
live lock or a namespace lock after a draft row, and none takes a namespace
lock while holding a document lock: it computes the complete namespace set
first and revalidates. Live mutexes are held around a commit scope (an
inverse's live destinations). No writer-ingress epoch barrier remains.
No process-level draft lease or mutex exists: no save, frame, pull, Discard,
inverse or compaction takes one. Background timers remain armed across failed
pulls; only a committed run with no newer work may clear them.

## Authority, checkpoints, and derivation

A live document's authority identity and generation bind its loaded Y.Doc,
room, checkpoint, writer frame, Markdown replacement, and agent journal batch.
Persistence validates the binding under the document mutation lock and drops
stale bytes rather than relabeling them. Restore retires acquired handles and
rooms; late load or connection completion revalidates the binding. Sequence
bounds never authorize retired-generation history.

A checkpoint is a host-minted `CapturedCheckpointCut`, not a free state-vector
and watermark pair and not warm-room bytes. It covers every journal row at or
below its cut. Materialize outside the persistence lock, then revalidate
identity, generation, and retention under lock. Retention is tracked by the
head's generation-local retired-through sequence. A stale checkpoint returns
`stale_generation`; it does not manufacture a successful checkpoint ID.
Compaction exists but has no production caller, so live journal rows are never
deleted.

`domain/document-derivations.ts` is the sole projection pipeline for search,
listings, sizes, and the link index. It derives from a journal-locked durable
cut. Recovery
sweeps stale rows and retries failures without advancing certification; a
projection is never substituted for live Yjs when serving document content.

## Links and tree changes

Stored links and image sources carry stable `doc:` or `ahead:` identities;
Markdown does not. The scoped codec assigns or preserves those identities on
write and spells them from the current document tree on read. Moves and renames
therefore write no document bytes. Link extraction and revision hashing use
the same occurrence rules, and failed ahead-ref registration is repaired by
the derivation sweep.

A result's concurrent attribution reads only the room journal interval after its
stored observation position through the rendered cut. A read uses the resolved
Work-draft identity directly, so a chat that has never written needs no thread peer.
There is no preflight or second recheck. Baseline containment compares struct clocks
and the delete set: equal state vectors alone do not establish equality, so delete-only
writer edits are still attributed. Drafts have no generation or epoch reset.

`document_links` is a hint from a certified cut, never link authority. Changing
the extractor bumps its version, and no second post-write writer exists.

## Selective disposition and response retirement

Apply and Discard parse required-field selection variants and thread them
through revision-fenced attempts. Only an absent
selection chooses whole Discard; a present but incomplete or malformed selection
is HTTP 400, never a whole Discard. Class IDs,
immutable part keys, live revisions, and admission tokens are evidence for the
clicked class only; they never admit a replacement class. A missing selected
class is `stale` if a listed immutable member survives, and `gone` only when
none does and the request says its member list is complete
(`memberPartKeysComplete`): a client sends at most 500 members, an even sample
of a longer selection, and a sample cannot prove that no member survives.

A reply's save applies ordered per-segment journal rows to a provisional Work-draft
clone and never regenerates durable rows from a raw state-vector diff, which
would reintroduce cumulative tombstones. An unresolved sync dependency is an
integrity failure, never a partially journaled update. Manifest membership
mutations still journal cumulative sync bytes
([#753](https://github.com/haowjy/meridian-flow/issues/753)).

Forward inverses append ordinary immutable journal parts with restoration
aliases. They do not rewrite target rows, mark them reversed, or use a reserved
undo client. Card actions and model undo/redo share immutable edit origins and captured
text-derived disposition, but retain their own authorization and stack policy.
Draft-origin Revert never targets live. Applied parts revert in an active draft
as pending changes; closed drafts supply disposition but never write admission.

Every model call obtains a private room copy through `readRoom`; no resident helper
or thread-peer content cache survives between calls. Planning uses the model's
recorded frontier and the reply's own accepted mutations, while rendering uses
the fresh room copy. Replay drops a rejected logical write and its dependent
closure; the next call reads a fresh room and the surviving stages. Whole Discard
retires the addressed peer and does not roll back unrelated documents in the reply.

## Focused references

- [Draft model and durable records](draft-model-and-records.md)
- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Committed change trail](change-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[kb-archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/work/management/work-archive-and-delete.md
[eventual]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/eventual-consistency-over-latency.md

## Producer shutdown

`DraftPullService.shutdown`, ahead-reference registration `shutdown`, and
`DraftProjection.dispose` stop scheduling and join their running work. Callers await collaboration disposal before destroying
warm documents or resetting fixture rows. The PostgreSQL change-trail harness
owns that ordering in `dispose`; its mid-case `cancelScheduledPulls` and
`destroyWarmState` controls are not teardown. `flush` remains assertion-time
convergence, not shutdown.
