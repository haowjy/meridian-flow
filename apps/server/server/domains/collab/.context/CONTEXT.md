# collab — branch-backed document infrastructure

This page records the contracts that cross collab's Yjs, persistence, review,
and transport boundaries. The focused pages hold branch vocabulary, authority,
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

Preview and selective disposition use one `ReadReviewCut`. The first branch
read fixes a repeatable-read snapshot containing the branch (checkpoint ⊕ tail
through the read seam, with its revision and generation),
review rows, history status, live journal/head, thread titles, and live/draft
link views. It performs no room reads, pulls, provisioning, or repair. A
missing branch is `gone`, not an invitation to create one. Returned bytes and
scopes are detached before rich difference work begins.

Apply fences the displayed cut. Selective Discard fences the displayed class
identities and the server-vended closed-row/rich-effect evidence, allowing
independent draft typing but refusing changed selected evidence. Whole Apply
and whole Discard retain their existing document-level semantics. Corrupt
previews return a typed refusal without resetting state; the whole Discard
command is the recovery path for a corrupt branch.

Discard closes only peers whose upstream is the addressed Work-draft branch,
then retires those peers after commit. A fresh peer in the same thread and
peers for other Works survive. Thread-core invalidation is a post-discard
side effect, never a preview side effect.

## Save, replay, and grants

The thread-peer pool is the only model document entry point. Each call carries
the caller's `FileGrant`; writes run under the grant scope and a reply pins a
document to its first grant. The response transaction saves all live and draft
journals, receipt records, and callbacks together. Live rooms publish only
after commit, so rollback is invisible to open editors.

A chat's write mode decides only where its new AI writes go (D62); chats in
one Work may differ. A draft write never pushes itself live (D59): a draft
that an auto-apply chat leaves behind, or another chat keeps writing, waits
there like a kept change, and the dock shows it. Switching a chat to
auto-apply touches no draft; Apply stays the writer's command. Branches carry
no push policy. Trail reconciliation consumes transactional dirty signals and
never publishes a draft. Active unapplied rows do not delay a terminal receipt.

A reply's save resolves exactly the peer each document was pinned to and
refuses that document stale when the pin no longer holds (closed peer, reset or
closed branch, closed draft). Peers are created only by pulls in an existing
draft, never by a save.

Save confirms every grant used by the reply once, drops writes whose Work lost
access, and marks the remaining writes for the journal's no-grant guard. A
write against a different version from the thread's last read returns
`read_required`. Model inverse commands use the current destination grant and
the immutable edit policy, not a legacy journal selection.

Prepared replay treats ordinary concurrent chat edits and writer deletions as
Yjs peers. A planning-visible item disappearing is not by itself rollback
evidence. Only retired-generation structs or immutable inverse removals after
the helper cut revoke a staged write. Replay drops the rejected logical write
and its later dependency closure, retains independent writes, and reports the
typed refusal in notices and receipts.

## Work mode and branch persistence

Work write mode chooses the destination for new AI writes. A draft write never
pushes itself live, even if the Work changes to Auto-apply while the reply is
in flight. Switching to Auto-apply with pending changes explicitly chooses
`apply` or `keep`; branch data does not carry push policy. Applying an archived
Work refuses under the Work lock.

Live writer SET and agent writes routed to live preserve a pending Work draft:
pulls merge live edits into it without resetting its generation or settling its
authored rows. `./mf doc put --overwrite` is not that path: it deletes the
document and creates a new one at the same URI, and the new identity inherits
no drafts.

A Work draft is shared by every thread editing the same document in that Work.
Thread peers fork from it and retain the upstream branch identity and
peer-branch generation independently of the Work's current generation. Draft
Apply publishes its selected or whole branch through the single push seam;
Discard re-forks from live plus surviving rows and creates no restoration copy.

Attribution is based on immutable journal provenance and dependency closure,
not text similarity or block proximity. Writer rows retain their identity.
Independent deleting edits remain independent when their insertion clients are
different; cumulative delete ranges from retained rows still participate when
they are genuine dependencies. Agent writes use fresh writer clients and
journal their own transaction deltas. Recognized adjacent structural runs may
share a segment, but sharing a paragraph alone never joins edits.

## Transaction and lock contracts

Every branch write is fenced by its row's `revision`, under one of two
policies. An **exact** write commits only at the revision it was computed at:
appends through `appendRows`, an exact checkpoint rewrite through
`commitRewrite` (a peer's catch-up, an inverse's destination, an exact reset),
status and hold changes after locking the branch rows in ID order and bumping
their revision. A **fold** (a pull, compaction, a peer's re-fork, item
Discard's reset) commits over the replica's cursor instead: rows appended
since it was computed are applied into its checkpoint under the row lock, so
an intervening append never makes it miss, and only another rewrite does. No
write compares branch bytes. Whether a branch is
frozen is derived on every read from its draft's origin Work (archived,
deleted, or missing), never stored. A Work lifecycle transition (archive,
unarchive, delete, restore) locks and bumps every active branch of the Work's
drafts after its Work update, so a write judged before the transition misses
its revision.

Work-first order has one owner: the Works mutation boundary
(`projects/adapters/work-projection-mutation.ts`), a required dependency of the
branch store and of every collab store that writes draft or branch rows. It
locks the Works a write names, directly or through its drafts and branches,
`FOR NO KEY UPDATE` in id order, in the caller's transaction, before any draft,
inverse, document or branch lock, so every write enters Work, draft, document,
branch, the order the transitions take. A caller hands it its whole write set
once: `mutatePending` when the write's effect on review membership is known
only after it runs (it counts the Works' pending documents before and after
and touches those that moved), `mutateKnownWorks` when the caller already
knows the write moves these Works (a frame that flips its branch: lock, write,
touch, no count), and `lockWorks` for order alone (the frame's
fourth-attempt judgement, opening or closing a draft, Apply's batch plan,
a reply save's grants). `seam`
adds the bound edit grants' Works and confirms the grants; `requireActive`
refuses unless every Work of the set is active. No other collab code locks a
Work for a write; the live journal's seam locks only the bound grants' Works.
Creating a draft branch runs inside `mutatePending`: a branch made while its
Work archives is either fenced by the archive or read as archived. An
effect-neutral writer append enters no boundary: it takes only its branch row.
Tests use the same boundary (`test-support/work-projection.ts`), with no
catalog or availability publication and no pending counts. The append's
`UPDATE` carries a Work-is-active predicate, so the lifecycle decision and the
write are one statement.

An archived Work's draft is frozen to content-moving rewrites (D19). A rewrite
names its admission (`CommitRewriteInput.work`). A live→draft pull, a peer's
pull or containment reset and a peer's catch-up are `active`: their `UPDATE`
carries the Work-is-active predicate, and a pull or reset is refused first by
the boundary under the Work lock (`requireActive`). The pull answers
`inactive`, writes nothing and is neither retried nor re-armed; the next live
update after unarchive catches the draft up. A branch already gone when the
boundary resolves its Work (`DraftBranchMissingError`) answers `closed`, as
storage does, so a peer pull still reports `ThreadPeerPullLost`. A peer read on an archived Work sees the peer as it stands. Exempt,
by name (`any`): a settlement's reset completing a batch staged before the
archive (D1's settlement fence), Discard and purge (lifecycle operations
themselves), and compaction (content-free, and only an append triggers it,
which the append's predicate already refuses).

A writer frame takes no lease, mutex or document lock, and no lock beyond its
own statement. It is judged on a private clone of the published replica
(containment, edit receipts, `has_effect` against the stored `live_cut`),
then appended at the revision it was judged at; a miss destroys the clone and
judges again on the new revision. The fourth attempt holds the Work row and
the branch row. Only the first attempt fences a stale room (`1008`): a retry
exists because a concurrent commit moved the branch, and that commit's publish
can reach this room after the retry judges. An append that flips the branch's
review membership (`(has_effect OR blocking) AND` pending rows) locks its Work
first and touches the Work's projection. A replica is published only after its
commit. A frame that leaves more than 512 tail rows or 2 MiB of tail folds it in
the background (`compact`: no content, effect or `updatedAt` change). The
coordinator's `compacting` set keeps one fold per branch in a process; the fold
fence orders it against every other write, so a frame that lands meanwhile is
folded in and a rewrite that commits first makes it miss until the next frame
past the bound. A failure is logged as `collab.branch` `compaction.failed`.

Every bounded branch write (frame, reply save, inverse, pull, segment rows,
selective and item Discard) runs its attempts through `runBoundedAttempts`
(`domain/branch-attempts.ts`): capture and compute off every lock, one commit
scope per attempt (a root transaction, or one savepoint inside an ambient one)
opened before its first branch-store lock, and a miss that leaves that scope
before the next capture. The attempt owns its candidates: one completed
attempt transfers them to publication, and any unwind disposes the rest,
including a write whose own statement succeeded in a scope a later miss rolled
back. The bound's exhaustion outcome stays with each caller.

A reply save is an attempt across every participating core: prepare replays
each staged document on a candidate, consume appends per upstream inside one
savepoint, install publishes. A miss unwinds the savepoint and prepares again
from the original staged buffer, up to four attempts; the reply's `confirm`
runs once, and an attempt prepared before it is disposed if it throws. The
save and a thread core's tool-time accesses hold no branch: they prepare
through the coordinator's save operations (`withTransient`,
`prepareStagedRows`, `prepareCatchUp`, `commitSegmentRows`), which read
committed replicas and write only through revision-fenced attempts, and read
the journal through one `BranchReplayJournalReads` port. The confirmation is
the retained exception (D7): it runs once, outside the save attempt, and holds
its Work rows and draft and live advisory locks across attempts 2 to 4; only
branch rows release on the savepoint rollback. Apply, selective Discard and
pulls retry a moved branch up to four times, then refuse `stale`.

An inverse (Undo, Redo, revert, rollback, and the model's `undo`/`redo`)
captures without any lock: one read-only snapshot of each document's live
head, each affected draft at its revision merged with that live state, the
history and each draft's lifecycle. It plans on that capture, then commits in
one scope: the live mutexes of its live destinations, then a seam boundary
(`mutatePending` with `seam`): the captured branches' Works and the bound
grants' Works in id order, the grants confirmed, before any other lock (a
live-only inverse such as a named Work's Scratch reaches its Work only as a
grant Work). Then its `document-inverse` and document locks,
the live head check, and each draft destination's exact checkpoint rewrite at
its captured revision. Any moved revision or head unwinds the attempt and
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
that settlement's completion resets at, and it re-arms its debounce (D20): one
capture and merge per debounce period until the settlement completes or is
withdrawn and the next run commits, after which polling stops. That is the
only re-arm: an archived Work's draft (`inactive`, D19) waits for the next live
update after unarchive, and a closed branch leaves the active list. Live pulls
snapshot before any transaction and re-read branch membership. A thread-peer
pull reads its upstream with its generation and commits holding that row
`FOR SHARE`: an upstream re-forked since the read (`upstreamMoved`), or a
closed peer, abandons the capture as `ThreadPeerPullLost`. A shared pull
promise resolves when its attempt finishes, which is not always a catch-up:
`pulled` resolves after the commit, but a fenced live pull resolves once it has
re-armed the debounce, with nothing written, and the branch catches up on a
later run after the settlement completes. A caller joining an in-flight live
pull awaits one coalesced run that starts after its call, since the in-flight snapshot may predate a writer edit it must
see. Pulls run after persisted live updates, on branch review room open and
reconnect, and at agent tool boundaries; the room trigger is fire-and-forget
and Hocuspocus admission never waits for it.

Room loads read in the caller's transaction because that transaction may
already hold the authority head. Provisioning locks the canonical thread row
before committing the peer in a root transaction (a Work draft branch it needs
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
database Work rows (only through the Works mutation boundary), the draft row,
sorted namespace and advisory keys (an inverse's `document-inverse` keys, then
`lockDocumentMutation`'s document keys in ID order), then branch rows, an
upstream before its peer, otherwise ID order. No path takes a Work row, a
live lock or a namespace lock after a branch row, and none takes a namespace
lock while holding a document lock: it computes the complete namespace set
first and revalidates. Live mutexes are held around a commit scope (an
inverse's live destinations, item Discard, Apply completion). D1 retains two
captures under them, the live-scope exceptions: a live pull snapshots the live
bytes inside `withDocument` (before any transaction), and Apply staging
captures each document's LOCK-WS lock cut and prepares its publication under
those live scopes. No path awaits writer ingress while it holds a Work or
branch row: a frame that must commit before the scope is drained before the
scope's first row lock, and one admitted after it is post-cut work that misses
its revision. No process-level branch lease or mutex exists: no save, frame,
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
the extractor bumps its version, and no second post-write publisher exists.

Review attribution compares live, branch, and journal content from one cut.
It must preserve surviving Yjs identities, distinguish rich changes from text
changes, and leave incomplete ownership as `unclassified`. Missing authorship
never disappears from a complete hunk and never becomes invented AI credit.
Every class touching an unclassified hunk is `canApplyOrDiscard: false`; both
selectors refuse it as `incomplete_class`, so only document-level Apply or
Discard can settle it. Deleted text carries per-author spans (agent or writer)
from deletion attribution, since one deletion can contain both authors.
Publication uses canonical block identities, not display hash prefixes or
serialized prose. Agent preview operations carry their chat thread (with its
title, resolved in one batched lookup) and the journal row's turn and tool-call
ids so the app can open the chat at the write; writer operations carry none.
Review hunks and publication compare prose (`documentProseEqual`); pending
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
item Apply (the draft tree step) compares its location, live-text, and
generation tokens only at the staging check: staging is the consent boundary.

Thread-peer publication applies ordered per-segment journal rows to a
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

- [Branch model and durable records](branch-model-and-records.md)
- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Collab visual explainer](collab-domain.html)
- [Draft/live visual model](draft-live-model.html)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)
