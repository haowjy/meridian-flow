# collab — draft-backed document infrastructure

This page records the contracts that cross collab's Yjs, persistence, review,
and transport boundaries. The focused pages hold draft vocabulary, authority,
reversal, settlement, and WebSocket details; this page keeps their shared rules.

## Boundary and destinations

`CollabDomain` supplies Postgres/Hocuspocus adapters around
`@meridian/agent-edit`. Model reads and writes enter through the thread-peer
pool and carry an explicit destination. A `live` destination uses the live
core and creates no Work draft or thread peer; a `draft` destination uses the
thread-peer core and names its Work. Scratch and uploads are always live.

A reply may hold a live core and a thread core at once. Staged writes overlay
only reads of the destination to which they were pinned. A live read never
shows staged draft content. Rebinding is resolved again for each query; a
read-only draft query without a peer may pull live into the shared Work draft,
but does not create a peer.

The composition root wires required services and provider ports. It owns no
business behavior, mutable runtime state, or optional capability matrix.
`collab-facade.ts` only assembles the domain surface. Agent-edit owns the
memory-only mutation kernel; collab owns authorization, persistence,
coordination, settlement, and trail projection.

## Revision and review authority

`domain/document-revision.ts` produces a revision from the encoded Yjs
snapshot, holder URI, and sorted stored-link/image identities. It must include
both the delete set and the holder's link spelling: a state vector misses
pure deletion and a document snapshot misses tree-only moves. Reads and applies
compute the token synchronously in their prepared link scope; an unverified
recovery returns `null`, never a later read's token.

Preview and selective disposition use one `ReadReviewCut`. The first draft
read fixes a repeatable-read snapshot containing the draft (checkpoint ⊕ tail
through the read seam, with its revision and generation),
review rows, history status, live journal/head, thread titles, and live/branch
link views. It performs no room reads, pulls, provisioning, or repair. A
missing draft is `gone`, not an invitation to create one. Returned bytes and
scopes are detached before rich difference work begins.

The review compares live with the draft as its next pull will leave it: live
structs the draft has not pulled yet are merged into the cut's draft copy
before the difference. Pulls are debounced (2–10 s), so live is routinely
ahead of the draft; without the merge, another writer's new live text reads as
the draft's unattributed removal, and live's deletions as its insertions.

Apply fences the displayed cut. Selective Discard fences the displayed class
identities and the server-vended closed-row/rich-effect evidence, allowing
independent draft typing but refusing changed selected evidence. Whole Apply
and whole Discard retain their existing document-level semantics. Corrupt
previews return a typed refusal without resetting state; the whole Discard
command is the recovery path for a corrupt draft.

Discard closes only peers whose upstream is the addressed Work draft. A fresh
peer in the same thread and peers for other Works survive. Thread-core
invalidation is a post-discard side effect, never a preview side effect.

Every draft ends through one close, `DraftClose.closeDrafts(tx, selection,
cause)` (`adapters/drizzle-draft-close.ts`), with `cause` one of
`branch_closed`, `document_discarded`, `edit_discarded` or
`{ documentRemoved: record }`. It prelocks Work drafts in ID order, then thread
peers in ID order (a pull's upstream-before-peer order), derives the durable
`closed_cause` (`document_removed` for a removal, else `discarded`), settles
each Work draft's current generation, and joins the root transaction's
retirement batch (a transaction participant: a rolled-back savepoint's closes
leave with it). After the root commits the batch retires once
(`domain/draft-retirement.ts`): a draft whose document the same transaction
removed retires as a removal whatever its own cause (its rooms close `4208`,
its peers' staged writes are refused `{ removed: record }`), so a Discard that
closes a created document's drafts and then tombstones it still closes their
rooms `4208`; any other closed draft's room closes stale and its peers are
refused with their cause's `discarded_*` reason. A removal's selection names its
documents, whose live rooms close `4208` even with no draft, but only while the
removal still stands: after every matching room load settles, one batched record
read outside DB locks drops live rooms a Work Restore has since made living
again (draft rooms close by exact draft id; a closed draft stays closed). A
Restore that commits while that read is in flight can still have its new live
connection closed `4208`; the app's stale-4208 recovery reconnects it. Why a
reply's closed pin lost its write is one pure rule, `closedPinReason`
(`domain/closed-pin-reason.ts`), shared by the save fence and a failed peer
pull: a draft closed `document_removed` is the removal's even when its document
stands again (`removed: null`). The closer is
built at the composition root and its retirement bound by the collab domain once
rooms and cores exist (the `hocuspocusBinding.current()` pattern); unbound, as in
fixtures without rooms, it retires nothing. A caller whose commit happens inside
process-level live scopes (Discard) runs under `holdRetirement`, so retirement,
and a save racing it, never wait on scopes the committer still holds.
Retraction takes the same lock order before checking for other contributions
and closes rather than deleting. Removed documents refuse new draft/peer inserts
under their document mutation lock, after Work/thread and branch admission.

Only a committed removal closes live and draft sockets with `4208`. The room
helper closes the gateway transport before Hocuspocus's protocol close, which
otherwise arrives as `1000`. Failures are logged as
`collab.retirement.after_commit.failed`.

A discarded document's closed draft rows remain as lifecycle records, but their
journals are deleted, `state`/`state_vector` are zero-length bytea and
`live_cut`/`discarded_state_vector` are NULL. Zero-length state is deliberately
invalid Yjs: `readDraftAt` omits its checkpoint and `materializeDraftRead`
rejects it, including a raw zero-length checkpoint. It is never an empty document.
A `deleted` removal retains all bytes. Restoring the document does not reopen
its old drafts.

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
refuses that document stale when the pin no longer holds (closed peer, reset or
closed draft, closed branch). Peers are created only by pulls in an existing
draft, never by a save.

Save confirms every grant used by the reply once, drops writes whose Work lost
access, and marks the remaining writes for the journal's no-grant guard. A
write against a different version from the thread's last read returns
`read_required`. Model inverse commands use the current destination grant and
the immutable edit policy, not a legacy journal selection.

A call whose caller passes `recordingFrontier` (the read and write tools, and
reference reads) records an observation frontier in its room: the pulled
peer's upstream Work draft (`draft:<upstreamDraftId>`, never the peer id or the
draft generation), or `live:<documentId>:<authorityGeneration>`. The pool
resolves the room before the call (the generation through `FrontierRooms`,
`adapters/drizzle-frontier-rooms.ts`, isolated from any ambient transaction, so
a restore in between leaves the frontier on the old epoch and a failed read
records none), looks up the model's previous frontier there, and passes
agent-edit `observe: { room, prev }`; the outcome comes back with its
`frontier`. An undo, redo or revert passes `observeInverse` instead: its room is
the draft its result names it ran on (`DocumentEditResult.draftId`), or, when
null, the live room whose generation the pool read before the call. A staged
write does no frontier work. The reply's save, given `recordingFrontier`,
derives each saved document's room from its pin (`draft:<upstreamDraftId>`) or
its live core (the live room), looks up the previous frontier there before its
transaction opens, and returns each saved document's `frontier` at the
post-commit cut. `format: "edits"` reads record none.
`roomKeyFor` and `FrontierRooms` are temporary: once writes plan on the
frontier, results render from the room doc, whose authority identity is already
bound to it, and these lookups go ([decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/merge/ai-writes-plan-on-what-the-model-was-shown.md)). See
[runtime document text](../../runtime/.context/document-text.md#observation-frontiers).

Prepared replay treats ordinary concurrent chat edits and writer deletions as
Yjs peers. A planning-visible item disappearing is not by itself rollback
evidence. Only retired-generation structs or immutable inverse removals after
the helper cut revoke a staged write. Replay drops the rejected logical write
and its later dependency closure, retains independent writes, and reports the
typed refusal in notices and receipts.

## Work mode and draft persistence

Work write mode chooses the destination for new AI writes. A draft write never
pushes itself live, even if the Work changes to Auto-apply while the reply is
in flight. Switching to Auto-apply with pending changes explicitly chooses
`apply` or `keep`; draft data does not carry push policy. Applying an archived
Work refuses under the Work lock.

Live writer SET and agent writes routed to live preserve a pending Work draft:
pulls merge live edits into it without resetting its generation or settling its
authored rows. `./mf doc put --overwrite` is not that path: it deletes the
document and creates a new one at the same URI, and the new identity inherits
no drafts.

A Work draft is shared by every thread editing the same document in that Work.
Thread peers fork from it and retain the upstream draft identity and
peer-draft generation independently of that Work draft's current generation. Draft
Apply lands its selected changes or whole draft through the single push seam;
Discard re-forks from live plus surviving rows and creates no restoration copy.

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
holds the draft row to `COMMIT`; it still refuses a closed draft, another
generation, or a Work that is not active (the predicate is in the statement).
Journal ids are allocated after that lock, so within a draft and generation a
lower id is committed before a higher one is visible (tail order): a fold's
`checkpoint_seq = max(id)` is always a complete prefix. Under the lock one
separate statement reads the committed prefix since the caller's base, and
`finalizeAppend` (`domain/draft-receipts.ts`) owns every fact that depends on
it: containment, the novel trim (`Y.diffUpdate`), deletes the prefix already
held, the restoration certificate, authorship when the prefix moved, complete
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
[settlement-and-trail.md](settlement-and-trail.md)).

Every rewrite is fenced by the row's `revision`, under one of two policies.
An **exact** rewrite commits only at the revision it was computed at: a
checkpoint rewrite through `commitRewrite` (a peer's catch-up, an inverse's
destination, an exact reset), and every metadata change (a close, a hold, a
journal row's status) through the one door
`bumpDraftRevisions` (`shared/draft-revisions.ts`), which locks the rows in
ID order and bumps their revision with the change. A miss surfaces as
`DraftCasConflictError`, and the attempt captures again. A **fold** (a pull,
compaction, a peer's re-fork, item Discard's reset) commits over the replica's
cursor instead: rows appended since it was computed are applied into its
checkpoint under the row lock, so an intervening append never makes it miss,
and only another rewrite does. Whether a draft is frozen is derived on every
read from its branch's origin Work (archived, deleted, or missing), never
stored. Archive and restore lock no draft row and bump no revision (Work deletion also
removes its owned documents through the tree removal protocol, closing their drafts):
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
judgements at a time, fingerprints the committed replica against the stored
baseline (`live_cut`, frozen at creation and replaced only under a revision
bump), and writes `has_effect` with its watermark `has_effect_revision` through
`writeEffect` at exactly that revision, inside `mutate` (which reconciles the
Work's stored badge count and notifies only if it moved), under
`SET LOCAL lock_timeout = '100ms'`. That bound applies to each lock
acquisition (the Work, the draft row, the Works-notice participants), not to
the transaction; `55P03` is `contended` and retried on backoff, a moved revision
is re-judged at once, so the badge converges within the max wait once typing
pauses and eventually while typing. That is the contract, not a bound to
tighten: the job's write must never bump `revision` (an in-flight Apply staging
would miss), and the badge must not move back onto the append. Every writer of `has_effect` (the job, a pull or reset's
rewrite, `refreshDraftEffect`) writes the watermark with it; `-1` is stale
whatever the revision. A sweep (the `draft-effects` recovery lane, every 30 s)
pages the stale set by `(updated_at, id)` and marks what no entry tracks, so a
crash inside the debounce converges without another key. A legacy draft with
no stored baseline is established once by the draft-scoped `pullWorkDraft`; a
document whose settlement is terminally blocked parks it with one
`projection_baseline_blocked` warning until its next append. Review readers
(`isEdited`, the Works badge, Apply's item plan) may lag a key by that second;
the draft editor and Undo read the replica and receipts, never `has_effect`.
Tests that assert membership right after a write read through
`test-support/converged-review.ts`, which flushes the job first.

Migration 0064 added the watermark (migrate, then deploy): a server without the
baseline-writing creator makes rows with null `live_cut` and the default `-1`,
which the sweep finds and the pull repairs. The contract step comes in a later
deploy, once every server runs that creator: the gate query
`SELECT id, document_id FROM document_drafts WHERE kind = 'work_draft' AND
status = 'active' AND live_cut IS NULL` returns nothing (a remainder is a
document with a terminally blocked settlement, named by
`projection_baseline_blocked`, resolved through the settlement's own recovery),
then the next free migration adds `CHECK (kind <> 'work_draft' OR status <>
'active' OR live_cut IS NOT NULL) NOT VALID` and the one after it
(no-transaction) validates it (0065 is the change-trail cost fix, not this
step); the contract step also deletes the job's null-baseline arm and
`pullWorkDraft`, whose only caller that arm is.

A writer frame takes no lease, mutex or document lock. It is judged once on the
committed replica (admissible, its room, the echo exit, authorship as an early
rejection) and appended once; a concurrent writer costs it one row-lock wait,
never a second judgement. It first checks its room holds the committed replica,
and a room that does not has missed a delivery: it is reconciled to the replica
(`reconcileRoom`, logged as a `room_reconciled` warning) and the frame goes on.
Only a generation the draft has left, or a draft no longer writable, refuses
the frame (`1008`).

Room delivery has one owner: `install` in
`domain/draft-coordinator.ts`, the only place a replica becomes the draft's
committed replica. It runs when the store's transaction commits (a savepoint's
callbacks move to its parent on release and are dropped on its rollback, so a
rolled-back child installs nothing), installs only past the replica installed
by then, and sends this process's rooms what separates the two: the rows the new
replica was built from when they cover everything past the installed one (built
on it or on an older replica of the same checkpoint and generation: a frame with
the rows that landed before its lock, a reply's rows, a read's tail catch-up),
otherwise the document difference (a pull or
compaction that folded rows under the draft lock, a checkpoint catch-up, a
checkpoint another process wrote), or nothing when the content is unchanged. A
new generation closes the rooms of older ones instead. A transition at or below
the committed revision installs and sends nothing, so a read racing a local
commit delivers once. `install` reaches only rooms Hocuspocus has registered,
and Hocuspocus 4.3 registers a room only after its load hooks return, so a room
enrolls itself: its `afterLoadDocument` hook chains after
Hocuspocus's own registration, and the coordinator's `reconcileRegisteredRoom`
reads the draft and reconciles the room to it, or closes the room when the
draft left its generation while it loaded. From registration on, every
transition reaches it; enrollment covers what committed between its load read
and registration. The load itself returns state only for the generation it was
asked for, and the draft `connected` hook re-checks the generation as the live
one does. Rooms are Yjs replicas kept current by anti-entropy ([eventual
consistency][eventual]):
push delivery is the fast path, and the room is reconciled against the
committed replica (structs past its state vector plus the delete set) at every
exchange that reads the draft: its enrollment, every tab's SyncStep1 handshake
(the same `reconcileRegisteredRoom`, before Hocuspocus answers the tab, whether
the tab may write or only read), and a frame that finds its room behind. A room
that missed a delivery, or another server process's commit, therefore heals on
the next exchange and is never refused for it; the tab's own Yjs handshake then
brings the tab current. `1008` stays for a generation mismatch. Another process's
commits also reach this process's rooms when its runtime reads the draft for a
turn inverse's `deliverCommitted`. There is no periodic reconciliation: an idle
room with no exchange catches up at the next keystroke, rejoin or handshake.
A frame that leaves more than 512 tail rows or 2 MiB of tail folds it in
the background (`compact`: no content, effect or `updatedAt` change). Frames
and the fold they trigger are `domain/draft-writer-frames.ts`, over the draft
runtime surface (`DraftRuntime`: committed replicas, private candidates,
prepared writes, attempts) that `domain/draft-coordinator.ts` owns with the
operations on it: frame admission depends on the runtime, never on the
operations. Its `compacting`
set keeps one fold per draft in a process; the fold
fence orders it against every other write, so a frame that lands meanwhile is
folded in and a rewrite that commits first makes it miss until the next frame
past the bound. A failure is logged as `collab.draft` `compaction.failed`.

Every draft write runs through `runBoundedAttempts`
(`domain/draft-attempts.ts`), the one owner of a candidate's lifetime: capture
and compute off every lock, one commit scope per attempt (a root transaction,
or one savepoint inside an ambient one) opened before its first draft-store
lock, and a miss that leaves that scope before the next capture. The attempt
owns its candidates: a completed attempt transfers them to installation, and any
unwind disposes the rest, including a write whose own statement succeeded in a
scope a later miss rolled back. An append (a frame, segment rows) is one
attempt and never retries; only exact and fold rewrites (a reply save's peer
checkpoints, an inverse, a pull, Apply staging, selective and item Discard)
recapture on a miss. The bound's exhaustion outcome stays with each caller.

A reply save is an attempt across every participating core: prepare replays
each staged document on a candidate, consume appends per upstream inside one
savepoint, install delivers. A miss unwinds the savepoint and prepares again
from the original staged buffer, up to four attempts; the reply's `confirm`
runs once, and an attempt prepared before it is disposed if it throws. The
save and a thread core's tool-time accesses hold no draft: they prepare
through the coordinator's save operations (`withTransient`,
`prepareStagedRows`, `prepareCatchUp`, `commitSegmentRows`), which read
committed replicas and read the journal through one `DraftReplayJournalReads`
port. The reply's rows reach each draft as a sequenced append, like a frame's,
and never miss on a revision; a peer's catch-up checkpoint (`prepareCatchUp`) is
an exact rewrite, so a moved peer is the draft miss that makes the save attempt
again. The confirmation is
the retained exception: it runs once, outside the save attempt, and holds
its Work rows and branch-row and live advisory locks across attempts 2 to 4; only
draft rows release on the savepoint rollback. Apply, selective Discard and
pulls retry a moved draft up to four times, then refuse `stale`.

An inverse (Undo, Redo, revert, rollback, and the model's `undo`/`redo`)
captures without any lock: one read-only snapshot of each document's live
head, each affected draft at its revision merged with that live state, the
history and each draft's lifecycle. It plans on that capture, then commits in
one scope: the live mutexes of its live destinations, then a seam boundary
(`mutate` with `seam`): the captured drafts' Works and the bound
grants' Works in id order, the grants confirmed, before any other lock (a
live-only inverse such as a named Work's Scratch reaches its Work only as a
grant Work). Then its documents' mutation locks in id order,
the live head check, and each draft destination's exact checkpoint rewrite at
its captured revision. Those captured fences, not a lock of the inverse's own,
order two inverses of the same edit: the second misses, recaptures and finds
the edit already reversed (probe `d22-concurrent-undo` in
[the lock-free probe index](../../../../../../docs/qa/drafts-lock-free-probes.md)). Any moved revision or head unwinds the attempt and
recaptures; after four attempts one more capture is classified without
writing, so a plan that still applies is a `ReversalConflictError`, never a
semantic refusal. `markBlocking` (a held draft found by the plan) is its own short write
after the capture (Works, then the held rows, then the bump).

Each pull attempt is its own root transaction, outside a caller's response
and database transactions, and holds nothing between attempts: its candidate
and `has_effect` are computed before the scope, and it commits as a fold over the replica's
cursor, applying any rows appended since into the checkpoint under the row
lock (re-judging `has_effect` there only when it applied some). Frames never
make a pull retry; only another rewrite does. A live pull into a Work draft is
fenced by a pending settlement on its document rather than moving the revision
that settlement's completion resets at, and it re-arms its debounce: one
capture and merge per debounce period until the settlement completes or is
withdrawn and the next run commits, after which polling stops. That is the
only re-arm: a terminally blocked settlement answers `blocked` and does not
re-arm (nothing lifts it on its own, so polling would capture and merge
forever on an idle document), and a closed draft leaves the active list. Live pulls
snapshot before any transaction and re-read draft membership. A thread-peer
pull reads its upstream with its generation and commits holding that row
`FOR SHARE`: an upstream re-forked since the read (`upstreamMoved`), or a
closed peer, abandons the capture as `ThreadPeerPullLost`. A shared pull
promise resolves when its attempt finishes, which is not always a catch-up:
`pulled` resolves after the commit, but a fenced live pull resolves once it has
re-armed the debounce, with nothing written, and the draft catches up on a
later run after the settlement completes. A caller joining an in-flight live
pull awaits one coalesced run that starts after its call, since the in-flight snapshot may predate a writer edit it must
see. Pulls run after persisted live updates, on draft review room open and
reconnect, and at agent tool boundaries; the room trigger is fire-and-forget
and Hocuspocus admission never waits for it.

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
inverse's live destinations, item Discard, Apply completion). Two captures
still run under them, the live-scope exceptions: a live pull snapshots the live
bytes inside `withDocument` (before any transaction), and Apply staging
captures each document's LOCK-WS lock cut and prepares its Apply under
those live scopes. No path awaits writer ingress while it holds a Work or
draft row: Apply completion drains live writer admissions before the
scope's first row lock, and an admission that starts after the drain makes the
completion retry rather than wait. No process-level draft lease or mutex exists: no save, frame,
pull, reset, Apply, Discard, inverse or compaction takes one. Background timers
remain armed across failed pulls; only a committed run with no newer work may
clear them.

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
cut. Push completion derives in its ambient completion transaction, so trail,
projection, watermark, and settlement succeed or roll back together. Recovery
sweeps stale rows and retries failures without advancing certification; a
projection is never substituted for live Yjs when serving document content.

## Links and tree changes

Stored links and image sources carry stable `doc:` or `ahead:` identities;
Markdown does not. The scoped codec assigns or preserves those identities on
write and spells them from the current document tree on read. Moves and renames
therefore write no document bytes. Link extraction and revision hashing use
the same occurrence rules, and failed ahead-ref registration is repaired by
the derivation sweep.

Each concurrent-attribution preflight and final recheck uses its own upstream
cut. Baseline containment compares struct clocks and the delete set: equal
state vectors alone do not establish equality, so delete-only writer edits are
still attributed. The journal floor is a provisional, commit-bound cursor, never
a global maximum.

`document_links` is a hint from a certified cut, never link authority. Changing
the extractor bumps its version, and no second post-write writer exists.

Review attribution compares live, draft, and journal content from one cut.
It must preserve surviving Yjs identities, distinguish rich changes from text
changes, and leave incomplete ownership as `unclassified`. Missing authorship
never disappears from a complete hunk and never becomes invented AI credit.
Every class touching an unclassified hunk is `canApplyOrDiscard: false`; both
selectors refuse it as `incomplete_class`, so only document-level Apply or
Discard can settle it. Deleted text carries per-author spans (agent or writer)
from deletion attribution, since one deletion can contain both authors.
Apply uses canonical block identities, not display hash prefixes or
serialized prose. Agent preview operations carry their chat thread (with its
title, resolved in one batched lookup) and the journal row's turn and tool-call
ids so the app can open the chat at the write; writer operations carry none.
Review hunks and Apply compare prose (`documentProseEqual`); pending
effects and terminal settlement also compare managed manifest membership
(`documentEffectsEqual`). Manifest changes have their own review operations and
never become prose hunks.

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

No visible review operations is not permission to reset a draft. An empty
draft settles only when its complete document effect (prose, marks, attributes,
ordered children, and managed manifest membership) equals live; incomplete
attribution never makes a semantically changed draft empty. When a per-change
Apply or Discard leaves such a draft, its generation resets and the terminal
`itemDisposition` is `applied` if any current-generation row reached live, else
`discarded`; pushed history stays pushed. Cleanup failure after a committed
disposition leaves `itemClosed: false` and cannot reject the command. Staged
item Apply (the branch tree step) compares its location, live-text, and
generation tokens only at the staging check: staging is the consent boundary.

A thread peer's segment write applies ordered per-segment journal rows to a
provisional target clone and never regenerates durable Work journal rows from a
raw state-vector diff, which would reintroduce cumulative tombstones. An
unresolved sync dependency is an integrity failure, never a partially journaled
update. Manifest membership mutations still journal cumulative sync bytes
([#753](https://github.com/haowjy/meridian-flow/issues/753)).

Forward inverses append ordinary immutable journal parts with restoration
aliases. They do not rewrite target rows, mark them reversed, or use a reserved
undo client. Card actions and model undo/redo share immutable edit and
placement targets but retain their own authorization and stack policy. Model
revert is a new edit in the current destination.

Response helpers are private to agent-edit's committer. Every tool and scoped
read obtains a prepare lease; reporting uses disposable replicas. Rollback
keeps the helper until transaction outcome is known. When a write cannot
integrate, the helper is replaced with the current generation plus surviving
stages before subsequent tool resolution; dropped writes are named once in the
next result. Whole Discard retires only the addressed peer and does not roll
back unrelated documents in the reply.

## Focused references

- [Draft model and durable records](draft-model-and-records.md)
- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Collab visual explainer](collab-domain.html)
- [Draft/live visual model](draft-live-model.html)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[kb-archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/work/management/work-archive-and-delete.md
[eventual]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/eventual-consistency-over-latency.md
