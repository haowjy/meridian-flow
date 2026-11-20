# collab — draft-backed document infrastructure

This page records the contracts that cross collab's Yjs, persistence, review,
and transport boundaries. The focused pages hold draft vocabulary, authority,
reversal, and WebSocket details; this page keeps their shared rules.

## Boundary and destinations

`CollabDomain` supplies Postgres/Hocuspocus adapters around
`@meridian/agent-edit`. A model's document write is a command
(`modelEdits().run` and `.write`, [model edits](model-edits.md)); its reads enter
through the agent-edit router (`domain/agent-edit-router.ts`) and carry an explicit
destination. A `live` destination uses the live core and creates no Work draft; a
`draft` destination uses the thread's core over the Work draft (`thread-cores.ts`)
and names its owner: the chat's Work, or for a chat with no Work
its lineage (the first chat, its forks and subagents; a handoff starts a new one).
`shared/draft-owner.ts` is the one reader of a branch's owner and lifecycle
(`branchOwnerSql`). A lineage is writable while some chat in it is live; with none,
writes are refused; Apply, Un-Apply and Discard still work (Apply and Un-Apply land in a closed branch owner; an item whose file's own Work is closed bounces `returned`). Scratch and upload content is always live.

Nothing holds a write: each lands in its command's transaction, so a read always shows
the writes before it. Rebinding is resolved again for each query; a read-only draft query
without a Work draft may catch live content up into the owner's draft but creates none.

The composition root wires required services and provider ports. It owns no
business behavior, mutable runtime state, or optional capability matrix.
`collab-facade.ts` only assembles the domain surface. Agent-edit owns the
memory-only mutation kernel; collab owns authorization, persistence,
and coordination.

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
record and the command's outcome atomically. A stored outcome
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
The per-document HTTP Discard says what it takes: each item names a document and its `text`
(`"all"` or change ids) and `tree` (the branch's move, delete or create). It is one server command
over change ids, described in [apply.md](apply.md): the draft stays open and the text half is an
appended update, so a draft the writer has since typed over is discarded all the same, and Undo
brings back what still stands. The answer's `closed` is what left Changes whole. Its command row holds the
answer, and so is the bounce on an archived or deleted Work or a chat in Trash
(`settled: [returned]`, nothing taken). A Discard
never refuses: an item with nothing pending is answered from `settlementOf` (`already discarded`
when a Discard, or nothing, settled it; `overtaken` by the Apply that did), and the others in the
selection still discard. Whether a draft holds text is decided under its row lock from the draft
itself (`draftHoldsText`): `has_effect` stands in only when its watermark is the draft's revision, so
a projection lagging an Apply never makes a Discard take text that is live. Change ids name
changes at the state the writer read them: an item with ids also sends that draft's Yjs
`snapshot`, and `discardChanges` resolves the ids in the draft at it, then merges what setting
them back did there into the draft as it is now (`contentMerge`); a change the writer has
written over since stays, and the item is answered `already` like any item that took nothing. A
snapshot the server doesn't hold yet (`ApplyClickUnsynced`) is a 503 that stores nothing, as for a room Apply; the client waits for its typing to be acknowledged before it sends. The Work's records
are taken as the Work holds them when it runs. The tree half of every Discard is the
package's `discardDraft`, run with `treeListStore.submit` in each list the Work spans
(`adapters/drizzle-branch-discard.ts`): the pending records are settled `discarded` with the
command's id. A discarded drafted create is in no view, and its `documents` row and text stay
until the retention job purges them; Discard releases nothing. Work Discard all and purge share
the same kernel.

## Revision and review authority

`domain/document-revision.ts` produces a revision from the encoded Yjs
snapshot, holder URI, and sorted stored-link/image identities. It must include
both the delete set and the holder's link spelling: a state vector misses
pure deletion and a document snapshot misses tree-only moves. Reads and applies
compute the token synchronously in their prepared link scope; an unverified
recovery returns `null`, never a later read's token.

A Discard closes no draft: it appends the base side to the draft and leaves it open. A thread
core holds no draft state, so nothing invalidates it.

A draft row is deleted only by a Work's purge or a document's content purge, in the purging
transaction. `DraftClose.endDrafts(tx, selection)` (`adapters/drizzle-draft-close.ts`) writes
nothing: it selects the rows about to go and joins the root transaction's retirement batch (a
transaction participant: a rolled-back savepoint's entries leave with it). After the root commits
the batch retires once (`domain/draft-retirement.ts`): a draft whose document the same
transaction removed has its rooms closed `4208`; any other ended draft's room closes stale (`4205`)
and its peers are refused. Every removal registers its documents with the batch
(`DraftClose.registerRemoved`). A live delete ends no draft: the drafts stay ordinary drafts and
their rooms stay open. A removed document's live
rooms close `4208`, but only while the
removal still stands: after every matching room load settles, one batched record
read outside DB locks drops live rooms a Work Restore has since made living
again. A
Restore that commits while that read is in flight can still have its new live
connection closed `4208`; the app's stale-4208 recovery reconnects it. The closer is
built at the composition root and its retirement bound by the collab domain once
rooms and cores exist (the `hocuspocusBinding.current()` pattern); unbound, as in
fixtures without rooms, it retires nothing.
Removed documents refuse new Work drafts under
their document mutation lock, after Work/thread and branch admission; an
existing active Work draft is returned whatever the document's state, and a
write forks one that outlived a live delete (`requireDraftableDocument`).

Only a committed removal closes live sockets with `4208`, and the draft sockets
of the drafts a purge deleted. The room
helper closes the gateway transport before Hocuspocus's protocol close, which
otherwise arrives as `1000`. Failures are logged as
`collab.retirement.after_commit.failed`.

A `deleted` removal retains all bytes and ends no draft, so restoring the
document finds its drafts as they were. A content purge deletes the drafts' rows with the document.

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
is pending only if some change includes it, otherwise discarded. Removed-document precedence remains the caller's concern.

All projects currently have one `projects.user_id`, so this adapter never
queries human receipt history and provenance never carries `writers`. A
multi-user project model must supply bounded writer evidence and its kernel
naming before enabling that mode.

## Save, replay, and grants

A model's write runs in its command's transaction: the append, the receipt and the
stored tool result commit together, and live rooms receive the write only after commit,
so a rollback is invisible to open editors. The grant is confirmed once per write and a
write whose Work lost access is refused.

A chat's write mode decides only where its new AI writes go; chats in
one Work may differ. A draft write never pushes itself live: a draft
that an auto-apply chat leaves behind, or another chat keeps writing, waits
there like a kept change, and the dock shows it. Switching a chat to
auto-apply touches no draft; Apply stays the writer's command. Drafts carry
no push policy. Active unapplied rows do not delay a terminal receipt.

A write into a room where the model has no frontier plans on the current room.
A write with a usable frontier plans on that offline view and merges onto the
current room. Model inverse commands use the current destination grant and
the immutable edit policy, not a legacy journal selection.

Every model call reads its room fresh through agent-edit's `readRoom`. The
draft adapter (`domain/draft-agent-edit.ts`) catches the Work draft up with live, copies
the Work draft replica. The live adapter
(`adapters/hocuspocus-coordinator.ts` `liveRoomCopy`) reads the journal and
the room without the document mutex. A room is named from what was read:
`draft:<workDraftId>` (never the peer id or the generation) or
`live:<documentId>:<authorityGeneration>` from the copy's bound authority
(`domain/observation-rooms.ts`). The effective reader reads through the same
door and the same route: the pool's `routeRead` serves the tool read and
`readRoom` alike. A draft read goes to the thread's core when
the thread has a Work draft of the document, else live; an explicit live read always
goes live.

A call whose caller passes `frontiers` (the read and write tools, and
reference reads, which pass `recording` only) records an observation frontier
in the room its result rendered from. A write plans on the `planning` lookup
when usable, otherwise on the current room; neither path refuses concurrent text.
An undo or revert records in the room its inverse committed into
(`DocumentEditResult.room`). `format: "edits"` reads record none.
A model edit as a command records its own, in its transaction ([model edits](model-edits.md#what-the-model-was-shown)). See [runtime document text](../../runtime/.context/document-text.md#observation-frontiers).

A write to a Work draft lands in it after a Discard too: the draft is the same row, and its text no
longer holds the discarded words.
A removed document, an archived or deleted Work's draft
return the write instead: a `done` row with `settled: returned`, and the document as that chat
reads it now, its evidence stored in the row so the model's next write plans on it. A block the
writer deleted, merged or moved in a draft that is still open is returned too (`block_gone`, from
the write core). An insert whose anchor block the writer deleted lands where the anchor was: it is
new words, and the anchor's tombstone still places them.

Replay treats ordinary concurrent chat edits and writer deletions as Yjs peers. A
planning-visible item disappearing is not by itself evidence against a write. Only
immutable inverse removals after the model's frontier revoke one.

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
There is no draft reset or re-fork.

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
holds the draft row to `COMMIT`; it still refuses a Work that is not active (the predicate is in the statement).
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
median) is the append's whole row-locked transaction: a slower step there is
keystroke latency for every writer on the draft.

Every rewrite is fenced by the row's `revision`, under one of two policies.
An **exact** rewrite commits only at the revision it was computed at: a
checkpoint rewrite at an inverse's destination. A miss surfaces as `DraftCasConflictError`, and the attempt
captures again. Close locks active draft rows in ID order, writes only their
closed status and cause, and bumps revision; it does not settle receipts or
journal statuses. A **fold** (compaction) commits over the replica's
cursor instead: rows appended since it was computed are applied into its
checkpoint under the row lock, so an intervening append never makes it miss,
and only another rewrite does. Whether a draft is frozen is derived on every
read from its branch's origin Work (archived, deleted, or missing), never
stored. Archive and restore lock no draft row and bump no revision (Work deletion also
removes its owned documents through the tree removal protocol; a `deleted` removal leaves their drafts active):
every rewrite and model edit locks the Work through the Works
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
once, through `lockWorks` (opening a branch, Apply's batch plan, a model edit's
grants) or `mutate`, which is `lockWorks` then the write. Every Work locked
either way has its stored pending count reconciled at commit, and only a Work
whose count moved is notified (one SQL aggregate over the transaction's locked Works;
`projects/.context/CONTEXT.md`). `seam` adds the bound edit
grants' Works and confirms the grants; `requireActive` refuses unless every
Work of the set is active, and `allowFrozenLineage` lets a chat in Trash pass it. Discard and Restore keep `requireActive` (a closed owner bounces them); Apply and Un-Apply pass `requireActive: false` and `work: "any"` at their `prepareAppend`, so they land on a closed branch owner; each item's file owner is locked beside it and judged on its own (`apply.md`). `ensureActiveForWrite` takes the caller's `WorkWriteOptions` the same way. No other collab code locks a Work for a write; the
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
judgements at a time, compares `review_base` and `prosemirror` with
`blocksEqual` (empty fragment equals one default empty paragraph), and writes `has_effect` with its watermark `has_effect_revision` through
`writeEffect` at exactly that revision, inside `mutate` (which reconciles the
Work's stored badge count and notifies only if it moved), under
`SET LOCAL lock_timeout = '100ms'`. That bound applies to each lock
acquisition (the Work, the draft row, the Works-notice participants), not to
the transaction; `55P03` is `contended` and retried on backoff, a moved revision
is re-judged at once, so the badge converges within the max wait once typing
pauses and eventually while typing. That is the contract, not a bound to
tighten: the job's write must never bump `revision`, and the badge must not move back onto the append. Every writer of `has_effect` (the seed or projection job) writes the watermark with it; `-1` is stale
whatever the revision.
Lists' rows read that answer (`has_effect OR has_effect_revision < revision`) only for a
document live does not show (rule 7). `writeTextAnswer` is the one writer of the answer on a
judgement or an Un-Apply: it resyncs the document's list, under the list's key taken before the
draft row's (a judgement holds no document key, so it takes it; Un-Apply holds document keys, so
it locks the lists of its documents in Trash upfront and passes `listsHeld`), only when the document is in Trash and the answer differs from what the rows may
hold (a different stored answer, or a stale draft judged false). Un-Apply writes `true` with the
stale watermark in its own transaction, so its row is right at its commit.
A sweep (the `draft-effects` recovery lane, every 30 s)
pages the stale set by `(updated_at, id)` and marks what no entry tracks, so a
crash inside the debounce converges without another key. Review readers
(`isEdited` and the Works badge) may lag a key by that second;
the draft editor and Undo read the replica and receipts, never `has_effect`, and a Discard
trusts it only at a matching watermark.
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
A draft a purge deleted refuses with terminal `4205`, or removal `4208`.
An inactive Work refuses without ending the draft (`4409 access-changed:<why>`, `why` being
`work_archived`, `work_deleted` or `chat_frozen`, read from the owner as it is now).

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
has released. `domain/draft-coordinator.ts` owns read and save operation policy; `domain/draft-writer-frames.ts` owns writer admission.

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

Every draft write runs as an attempt (`runAttempt`, or `runBoundedAttempts` where a miss recaptures;
`domain/draft-attempts.ts`), the one owner of a candidate's lifetime: capture
and compute off every lock, one commit scope per attempt (a root transaction,
or one savepoint inside an ambient one) opened before its first draft-store
lock, and a miss that leaves that scope before the next capture. The attempt
owns its candidates: a completed attempt transfers them to installation, and any
unwind disposes the rest, including a write whose own statement succeeded in a
scope a later miss rolled back. An append (a frame, a reply's rows, a content rebase or an Apply review-base update) is one
attempt and never retries; exact and fold rewrites recapture on a miss. The bound's exhaustion outcome stays with each caller.

A model write is one `modelEdits().write` in its command's transaction: it reads the
committed replica and the journal through one `DraftReplayJournalReads` port,
`prepareSave` plans on a private copy, and the rows reach the Work draft as a sequenced
append under its row hold, like a frame's, never missing on a revision. Its confirmation
runs once, and its Work rows and branch-row and live advisory locks are taken first
(`enterDraftSeam`, `approveBranchWriteJoin`).

An inverse (the card's Undo, revert, and the model's `undo`)
captures without any lock: each document's live state, each committed draft at
its revision without merging live identity, the history and each draft's
lifecycle. Those reads need not agree with each other. It plans on that capture,
then commits in one scope: a seam boundary
(`mutate` with `seam`): the captured drafts' Works and the bound
grants' Works in id order, the grants confirmed, before any other lock (a
live-only inverse such as a named Work's Scratch reaches its Work only as a
grant Work).
Then its documents' mutation locks in id order and its drafts' rows. The capture only
chooses the steps: each step reads the committed text under those locks and takes out what
stands there (a draft's step re-runs `takeOutStanding` under the draft's hold; the manuscript
step reads Live again under the document key and re-runs `takeBack`). A write that landed after
the capture changes what a step takes, never whether the inverse runs, so it never answers
"changed while reversing". The locks, not a check of their own, order two inverses of the
same edit: the second finds the edit already out and takes nothing (probe `d22-concurrent-undo`
in [the lock-free probe index](qa/drafts-lock-free-probes.md)).

Live merges only into drafts someone has open (`domain/draft-pulls.ts`). Two entry points:
`liveCommitted(documentId)`, a plain notice that carries nothing from the calling process; and
`catchUpDraft(draftId)`, which every reader that shows a draft's text calls before it takes any
lock. Every Live write sends the notice from one place: the live journal's `append`,
`appendWriterUpdate` (when it stores a row) and `appendBatch` fire it after the writing
transaction commits (`createDrizzleJournal`'s `appended` hook). Live sync, a model's live
commit, `writeDocument`, a code merge, Apply, Un-Apply and a live Undo step all pass it. An
authority replace or restore changes Live without an append, so it sends the notice itself.
The composition's `liveAdvanced` is the one fan-out of that notice: draft pulls, document
derivations and the Agents-level text hints each subscribe, and each debounces per document
with the shared `createKeyedCoalescer` (`shared/keyed-coalescer.ts`: trailing debounce, maximum
wait, one run per key and a rerun when it fired mid-run, stop joins). The projection job and
draft ahead registration use the same coalescer on their own cadence. A new consumer of Live's
text subscribes in `liveAdvanced`; it adds no hook at a write site. A direct write (a model edit,
Apply) already derives inline, so the scheduled derive first asks the store whether the document
is still stale and skips it when not. The pull debounces per document (2 s, 10 s maximum); when
it fires it reads Live once for the
up-to-date check all the open drafts share and catches up each draft room open then. It never waits, and a draft with no room is not touched, so
background merge work grows with the drafts open on a screen, not with the drafts that exist.
`openDraftRooms(documentId)` is an in-memory index in `hocuspocus-persistence.ts` (document →
open draft rooms), added when a room enrolls and dropped at `afterUnloadDocument`; it makes no
database call. A draft catches up when it is read or opened: a room's first catch-up runs in
`enrollHocuspocusDraftRoom` once Hocuspocus has registered the room (any Live commit before it
falls inside that read, any after finds the room), each later client connection to an open room
catches it up again (so a failed push heals on the next connect), and the room's `catch_up`
message, model tools (`modelEdits().catchUp`, `readRoom`) and effective reads (Copy, export,
search fallback) call it. A failure of an opened-room catch-up is reported as the pull service's
`background.failed`. A caller joining a running catch-up of the same draft waits for a rerun that
reads Live after its call. Readers that merge (Apply, Discard, Un-Apply, card Undo and revert)
never catch up: they merge against the base they find, and a catch-up inside their lock would
open a second connection (`assertOutsideCommandTransaction`).
Accepted: an unopened draft that Live has caught up to still counts as pending, and may hold
its document under retention a little longer, until someone opens it (the stored `has_effect` and
`text_changes` only move on a write): the Changes list, counts and Work badge over-count, never
under-count. A long-unopened draft takes one big merge when opened. Open-room state is this
process's: one server process runs today (KB `architecture/hosting.md`, #588). A catch-up
re-reads committed Live and the draft under the draft row hold, so a duplicate or late notice
is harmless and nothing depends on the notice and the pull sharing a process. Several processes
need one of two changes, neither built: route each document's draft rooms to one process, or
replace the `openDraftRooms` index with shared presence and fan `liveCommitted` out to every
process (for instance Postgres LISTEN/NOTIFY); otherwise a draft open on another process
misses Live edits until its next read.

A catch-up skips drafts whose base already matches live. Off-lock,
the service reads committed live. Under the draft row hold its async append author re-reads committed live through
the live journal's single-statement authority/checkpoint/tail read, rematerializing
it fully rather than caching an incremental cut. It calls `rebase(base, live, draft)`
and writes both fragments in one client-1 transaction, one `source: server` row.
It takes neither a live lock nor a Work boundary, capture or revision predicate, and runs for
any Work lifecycle (`work: "any"`): a server rebase is not an incoming edit, so an archived
Work's draft opened read-only shows current text. Server append events include
`holdMs` and `serverRows` for measuring hold time.

Writer and agent admission runs `findLostEdits` against the committed prefix.
A writer's typing that the deleter never saw is recovered, whoever deleted: a
rebase, a peer's Discard revert, another writer or the model. Two arrival orders
find it. Typing that arrives under a block already deleted (its parent chain
reaches a deleted item, judged by the committed document however the update
encodes the ancestor), and a delete that arrives after the typing and removes it
without listing it (a deleter's delete set lists every item its own transaction
deleted, children included, so an unlisted item was typed unseen). The typist's
view of the text beside its words is its own frame's delete set when the typing
arrives second, and the document before the frame when the delete does.

Whose text it is comes from the journal, never from a client id or a cache. A
frame's typing counts when the row is `writer`'s. Typing a delete removed counts
when `DraftStore.writerText` finds the inserting row: a `writer` row, or a
recovery row (`updateMeta.lateTyping`) in `document_edit_parts` of the draft, or
a row of the same append not yet journaled. The model's rows and the server's
pulls never count, and nothing is lost when the process restarts. Recovery authors another client-1 server row
in the same append; its opaque per-draft `LateTyping` memory (spans only, to extend
a paragraph in place) installs only after commit. A paragraph is extended by
inserting the new characters where the typist placed them among the old ones, so
the characters a peer saw keep their ids; paragraphs the typist's edit would join
stay separate for the same reason. Deletion-only frames advance memory
without writing; a contained echo with existing recovery observes its deleted
separators without a row hold. Deferred observers read latest memory at commit
(`retainLateTypingDeletions` keeps the kernel's memory bound). Stale backspaces
never remove recovered writing. Losses that stay are under Known losses in
[content-merge](../../../../../../packages/agent-edit/.context/content-merge.md);
live rooms have no recovery: see TODO.

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

1. Live `withDocument` mutexes (sorted), before any transaction.
2. In the database, the command's claim row (`runCommand`).
3. Thread rows of a Work's tree, parents first, when the command changes a Work's lifecycle or
   reverses a card's Work receipts (`lockWorkThreadTrees`: all the threads, then all the Works
   and lineages, so several Works never interleave their phases). A card's reversal locks only
   its receipt Works' threads and the chat's own, and each as the runtime's thread lock does
   (`lockThreadAsRuntime`: the thread's asks, the inbox advisory lock, the row), since its Work
   step ends those chats through that lock; the documents' Works lock as rows alone. Then Work rows (only through
   the Works mutation boundary, in ID order, with the lifecycle and grant locks `lockSeamWorks`
   takes), then the branch row.
4. **Every tree list key the command will write or resync**, in list-ID order: the project's list
   and the account's. A path that takes document keys takes all of them here (`treeLists.lock`,
   or `lockProjectTreeList`, which takes both of a project's), and no path takes a list key after
   a document key. A list's key sorts before every document key, not among them by ID.
   Then the namespace keys the command knows before it writes (`lockDocumentNamespaces`: a Work
   restore's, which a card reversal takes here, ahead of its documents, through
   `works.lockRestoreNamespaces`). One exception: a model edit's `registerInCommand` takes the
   namespace keys of the ahead refs it mints, which exist only as the edit plans under its document
   key, so they follow the document keys there. A path that takes namespace keys first and then a
   document key can therefore cross with it; none does today (Apply's and a restore's settle
   under the keys they hold).
5. The sorted document advisory keys (`lockDocumentMutation`, in ID order).
6. Writes: a list's journal append and the rows it materializes (`tree_nodes`,
   `branch_tree_nodes`, `tree_node_ids`, `documents`), then the draft rows, in ID order. Derivation
   certification takes a document key and then locks that document's `tree_nodes` row, so a path
   that holds a document key writes its rows after it, and one that writes first never takes that
   document's key afterwards.

- **Restore:** the Work lock (`mutate`); `ensureActiveForWrite`, always; the branch; the lists; the
  documents of the Discard's records and effects; then the draft rows, in ID order.
- **Un-Apply:** the Work lock; the branch; the lists; the documents of the Apply's text; the tree
  half. It reopens nothing: an Apply of a delete leaves the Work's drafts open.

`submit` and `resync` take the list keys themselves when a path holds no document key, as the
tree tools do. `resync` takes none: it throws when the transaction does not hold the
key, so a path that would take one after a document key fails in its first test, not as a
deadlock. Apply, Discard of items, a card's tree Undo and the purge all take the key, then the
documents', then write. A path with a second list in view (a purge's drafts) reaches only the list that holds the document, which it holds. A tree list's write
(`withLists`) takes the seam's Work locks first, so the append under the key takes no lock it
lacks; a Work's close, archive, restore and delete takes both lists' keys after its Work row and
before its document keys (`lockProjectTreeList`), so the open Works an admission reads under that
key are current. No path takes a Work row, a live lock or a list's key after a draft row, and
none takes a list's key while holding a document key. No writer-ingress epoch barrier remains.

A document command (a model edit, a tree tool call, `reverse_turn`, Apply, Un-Apply, Discard,
Copy, the server's move between a project's list and the account's) runs in
`runCommand` (`shared/commands/drizzle-commands.ts`, through `adapters/drizzle-document-commands.ts`): one transaction, `runInCommandTransaction`,
whose first write is the claim, then the list above from the Work rows on. It takes no
`withDocument` mutex: a command that needs a live room reads its journal in the transaction
under the document key (`ensureLiveDocumentDraft`, `committedCopy` under `inLockedWrite()`). A
read a command plans on is taken, or taken again, under the locks of what it read: the inverse
captures off-lock to choose its steps, then reads the text each step writes under its Works,
document keys and draft rows. A miss the server retries (a deadlock, a serialization failure,
a moved owner) rolls back past the claim and is never stored
as an outcome. In dev and test, a `KeyedMutex` or a second connection taken while a command
transaction is open throws (`assertOutsideCommandTransaction`): a wait on either is invisible to
Postgres and can hang both sides for good. The tree list store takes no mutex (its in-memory
copy is marked `pending` by the root transaction that changed it, and any other transaction
reloads; a rollback at any depth drops the copies the transaction held), so it joins the command's
transaction. A card Undo's Work receipts run in the same command as its documents
(`reversal.md`): the command declares every Work and thread it will lock and takes them before
its first document key, and reruns when its commit finds a Work it did not declare.
No process-level draft lease or mutex exists: no save, frame, pull, Discard,
inverse or compaction takes one. A failed push is reported and not retried: the next Live
commit, the next connection to the room, or the next read or open of the draft, catches it up.

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

`domain/document-derivations.ts` is the sole pipeline from Yjs to stored text:
block rows, the order and counts on the room row, `documents.size_bytes` and
`updated_at`, and the link index. It derives from a journal-locked durable cut and
projects the cut's own private doc with `projectBlocks`, with no copy. Recovery sweeps
stale rooms and retries failures without advancing certification.

Storage is `document_block_rooms` (one row per document: `block_order`, word count,
`document_hash`, and the `cut_*` and `extractor_version` watermark) and
`document_blocks` (one row per top-level block, keyed by its Yjs item id: `text`,
`content_hash`). A block row never holds its position, so inserting a
paragraph rewrites one array and no block row. Certify (`certifyDocumentDerivation`) is
under `lockDocumentMutation` and does only this: compare-and-set the cut against the
head and location version, read the `(block_id, content_hash)` pairs, upsert the blocks
whose hash changed (all of them when the room's `extractor_version` is older than the cut's,
since a hash does not cover how the text was extracted) and delete the removed ones, replace `document_links`, and write the
room row (`block_order` only when the order moved). Text is produced and hashed before
the transaction, so certify never reads text back and a later normalizer can run there
too. Certify reads the project only for a new room or a moved one (`cut_location_version`
differs): a move bumps the location version, so the re-derive corrects `project_id`.

Reads of the block rows go through one port, `BlockText` (`domain/ports/block-text.ts`,
`adapters/drizzle-block-text.ts`): `grepTexts` and `wordCounts`. The adapter owns freshness. A
reader trusts a room only when its `cut_*` match the head and location version and its
`extractor_version` equals the code's (`staleForReaders`); anything else is unknown to the
reader, which reads the document itself (grep) or shows nothing (`ls -v` word counts). The
sweep (`staleForSweep`, on the writer port's `stale`) differs on one point: it skips a room a
newer extractor certified, because builds overlap in a deploy, the older build's certify
refuses that room, and retrying it burns three attempts per room per sweep. A later read-side
prefilter should extend `grepTexts` (required literals in, a skip set out) rather than add a
second reader.

One function, `grepBlocksOf` (`domain/grep-blocks.ts`), projects a doc into blocks with their
destination-free markdown and grep text. The derivation hashes and stores it; `readHashlines`
adds bodies and links. That shared path is why the stored and room-copy texts agree.

`document_hash` is the ordered block `content_hash` list plus the certified link facts;
`updated_at` moves only when it changes, so an extractor bump or a move is not an edit.
`content_hash` is the hash of the block's destination-free markdown, not of its text, so
a formatting-only edit still counts as an edit. A block's `text` is the destination-free
markdown decoded to the text view; a code file's block is its code node's text with no
fence (`grepBlockText` in agent-edit). Sizes are therefore destination-free byte counts.

Stored text is never substituted for live Yjs when serving document content, with one
exception: `grep` matches a document's stored text (the blocks' `text` joined with `\n`
in `block_order`, in one statement with the freshness check, and equal byte for byte to
the room-copy path's text) when the room is current,
the reader's own Work has no active draft of the document. Bump `DOCUMENT_EXTRACTOR_VERSION` when what a block row holds changes.
Nothing else reads stored markdown: `ls -v` word counts come from `BlockText.wordCounts`
(current rooms only), the trash preview is the engine's `readFrozenMarkdown`, which
serializes the stored Yjs on request, and `ensureDocumentAuthority` seeds an empty document
when a document has no state.

## Links and tree changes

Stored links and image sources carry stable `doc:` or `ahead:` identities;
Markdown does not. The scoped codec assigns or preserves those identities on
write and spells them from the current document tree on read. Moves and renames
therefore write no document bytes. Link extraction and revision hashing use
the same occurrence rules, and failed ahead-ref registration is repaired by
the derivation sweep.

A copy reads one document's frozen cut (`readEffectiveBlocks`): a Draft view uses the Work's
draft when present, otherwise live content, with links spelled in the Draft tree. The cut holds
its projected blocks, the
revision that version reports, the holder its links spell from, its Yjs state vector, and
where each `ahead:` ref in the cut settles now. `bindCopiedBlocks` turns those blocks into a
fresh `BoundWrite` for a new holder through `domain/copied-blocks.ts`: identities inside the
copied set (a settled ahead ref included) name the copy, a ref-less internal spelling is read
from the source holder and either remapped or written absolute, an unsettled ahead ref whose
address now holds a copied folder names that folder (an ahead ref settles only on documents),
and everything else keeps its target. It resolves no catalog and mints no ahead ref, so it is
safe inside the copy's transaction — the one whole-document door that binds there rather than
before it. The
model's `copy` tool runs the same `remapCopiedBlocks` over its own read's blocks, with the
settlements from the same cut.

A result's concurrent attribution reads only the room journal interval after its
stored observation position through the rendered cut. A read uses the resolved
Work-draft identity directly, so a chat that has never written needs no Work draft.
There is no preflight or second recheck. Baseline containment compares struct clocks
and the delete set: equal state vectors alone do not establish equality, so delete-only
writer edits are still attributed. Drafts have no generation or epoch reset.

`document_links` is a hint from a certified cut, never link authority. Changing
the extractor bumps its version, and no second post-write writer exists.

## Selective disposition and response retirement

Discard takes a selection: the whole branch, or items each naming a document,
its origin and what it ends. What it took decides the answer, and every answer is
`discarded` with its `settled` lines (`work-branch-review-service.ts`).

A draft write never regenerates durable rows from a raw state-vector diff, which
would reintroduce cumulative tombstones. An unresolved sync dependency is an
integrity failure, never a partially journaled update. Manifest membership
mutations still journal cumulative sync bytes
([#753](https://github.com/haowjy/meridian-flow/issues/753)).

An inverse is an ordinary immutable edit. It does not rewrite target rows, mark them
reversed, or use a reserved undo client. Card actions and model undo share immutable edit origins and captured
text-derived disposition, but retain their own authorization and stack policy.
Draft-origin Revert never targets live. Applied parts revert in the draft
as pending changes.

Every model call obtains a private room copy through `readRoom`; no resident helper
or content cache survives between calls. Planning uses the model's
recorded frontier, while rendering uses the fresh room copy. A Discard closes the
addressed draft and leaves the Work's other documents alone.

## Focused references

- [Draft model and durable records](draft-model-and-records.md)
- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Model edits as commands](model-edits.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[kb-archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/work/lifecycle.md#archive-freezes-the-works-own-material
[eventual]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md

## Producer shutdown

`DraftPullService.shutdown` (joins pushes and catch-ups), ahead-reference registration `shutdown`, and
`DraftProjection.dispose` stop scheduling and join their running work. Callers await collaboration disposal before destroying
warm documents or resetting fixture rows. The PostgreSQL collab harness
owns that ordering in `dispose`; its mid-case `cancelScheduledPulls` and
`destroyWarmState` controls are not teardown. `flush` remains assertion-time
convergence, not shutdown.

## Import staging

Import preparation produces Yjs state, a state vector, and attribution without publishing document authority. Staged states remain private until Context reveals the matching generation; commit installs sequence-zero checkpoints and heads in the journal adapter's authority order, while discard removes only the bounded staged batch.

A first state is written one of two ways, by where its content comes from. Import stages it (`prepareSeed`, `stageInitialStates`, `commitStagedStates`), because the import queue must keep the encoded states across generations and discard them when a generation is refused. A Copy encodes it in memory (`encodeSeed`) and installs it inside the transaction that inserts the documents (`installSeeds`), because it holds the bound content already and has nothing to resume. Both install heads and sequence-zero checkpoints set-wise; neither writes over an existing head.

Planned import binding uses stable `doc:<id>` targets before those documents are visible. Its ahead mints remain unregistered until reveal. Ordinary binding still runs before the command transaction, uses the current `LinkView` and folder addresses, and registers through the durable refusal-preserving registry.
