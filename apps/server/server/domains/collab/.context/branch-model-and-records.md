# Collab — branch model and durable records

## Vocabulary

Names that look alike and are not. Code, docs and wire types keep them apart.

| Name | Is | Owner | Crosses the wire as |
|---|---|---|---|
| **draft** | The Work's one active draft (`drafts` row). Closes only on Discard all and purge; Apply never closes it. | the Work-draft lifecycle (`shared/work-draft-lifecycle.ts`) | `draftId` |
| **item** | One document's place in a draft, with or without a text branch (an empty create, a created image). | `domain/draft-review-identity.ts` (the one module that maps item to branch) | `itemKey` = `${draftId}:${documentId}` |
| **text branch** | The item's per-document `work_draft` branch (`document_branches`, keyed `(documentId, draftId)`): a Y.Doc with `prosemirror` and the server-owned `review_base`, plus the thread peers that fork from it. | the branch store and peer pool | never the id; only the room name |
| **room name** | The text branch's collaboration room. A new text branch for the same item (after a close, a later write ensures a fresh one) has a new room name and the owner rebinds. | the review service | `roomName` = `branchRoomName(draftBranchId)` |
| **base** | `review_base` (live's text as of `base_revision`), the reference every change is measured against. | the rebase and the Apply base patch | `REVIEW_BASE_FRAGMENT`; `base_revision` stays server-side |
| **has changes** | `!blocksEqual(review_base, prosemirror)` for a text branch; false for a branchless item. | `writeBranchState` | `hasChanges`; column `has_effect` |
| **change** | One group of the review projection (`projectReview`): one red/green unit. The browser computes it; the server never stores one. | `@meridian/agent-edit/diff` | `changeId`, `changeIds` |
| **command** | One writer action: item Apply, Apply changes, Apply all, item Discard, Discard all. Idempotent under its `commandId`. | the review service and command records | `commandId` |
| **presented address** | What the writer is looking at: `{ workId, itemKey, changeId? }` (URL `item=` and `change=`, dock persistence). Names no branch. | the client | the API review selector `reviewWorkId` + `itemKey` |

```text
Work 1──1 active draft 1──* item ──0..1── text branch 1──* thread peer
                              │                  │
                              │                  └ room: branchRoomName(draftBranchId)
                              └ presented address (workId, itemKey) ─ command (commandId)
```

An item with no text branch still resolves, lists and applies (item Apply).
The server resolves every `itemKey` through the identity module; no function takes
a bare string that may be a draft id, a branch id or an item key. An item is
**addressable** when the active draft has an active text branch or a tree row for
the document, and **listed** by the predicate in
[Membership](#membership). A listed item is always addressable; an emptied
edited item is addressable and unlisted.

## Branch model

Branches are real Y.Docs. There is at most one active Work-draft text branch per
`(documentId, draftId)`; every thread peer for that document and draft shares it as
upstream and carries the same `draft_id`. A branch's Work is its draft's origin
Work, read only through `draftBranchWorks`/`branchDraftWork`
(`shared/work-draft-lifecycle.ts`); a draft with no origin Work is frozen.

A text branch's document holds two fragments:

- `prosemirror`: the draft text. The writer edits it in the review room; agent
  writes land in it through the thread peer's save.
- `review_base`: live's text as of `base_revision`. Only the server writes it
  (`SERVER_OWNED_ROOTS` in `domain/provenance.ts`), so writer admission refuses an
  update that touches it. The browser projects the two fragments into changes.

`document_branches` carries `base_revision` (jsonb, the live revision `review_base`
reflects; null means no base was ever written and the rebase refuses
`base_uninitialized`), `has_effect` and `blocking`. A new text branch is seeded by `seedDraftState`: live's text written
twice as fresh items by the reserved server client (`DRAFT_SERVER_CLIENT_ID`, 1),
once into each fragment, with `UNKNOWN_BASE_REVISION` (older than every real
revision, so the first rebase reconciles whatever moved). The draft shares no Yjs
lineage with live; no live client's items are in a text branch.

**One branch-state write.** Every runtime write of a branch's state (writer
admission, late-peer recovery, the rebase, seeding, settlement's base patch,
inverse admission) goes through the branch store's `writeBranchState`, on the
caller's transaction. It is a compare-and-swap on the full prior `state` that
writes state, `has_effect` (the effect arm: `text` states `draftDiffersFromBase`
of the document being written, `peer` carries no membership effect),
and `base_revision` together or not at all, inside the Work
projection mutation so the Work page and catalog see an effect change in the same
transaction. The raw CAS (`casBranchState`) is private to the adapter.

**The rebase** (`domain/draft-rebase.ts`, reached from `branch-pulls.ts`) replaces a
Yjs pull for every `work_draft` branch: a three-way content merge of base, live and
draft, never a sync, because nothing relates live's items to the draft's. It holds
the branch's lease, reads live's **certified cut** (`adapters/drizzle-live-cut.ts`:
live's content and revision from one durable journal materialization, never a warm
room paired with a watermark, so a revision may lag its content but never lead it),
and writes both fragments in one `doc.transact(…, "rebase")` as client 1 through
`writeBranchState`. It is a no-op when live's revision does not advance
`base_revision`, refuses `base_uninitialized`, leaves a fragment that already holds
the result untouched (rewriting equal text would replace its items), and is fenced
while any settlement batch with a member on the document is `pending` or
`blocked`: an unfinished Apply has written live but not yet patched the base. A
rebase failure is typed (`DraftRebaseFailedError`), not retried on the same inputs,
and reported once per transition.

**Late-peer recovery (D33).** A writer's update authored before the peer got a rebase
can type into blocks the rebase removed or retyped. A stale frame is not current
intent: on text a rebase changed it contributes only its net surviving typing.
Writer admission (`commitWriterUpdate` under the branch's critical section) finds
that typing before applying the update (`findLostEdits`: inserted text minus what the
same frame deletes) and
writes one ordinary `writer` journal row holding the update merged with the recovery
(`recoverLatePeerEdits`): the typing goes in as its own paragraph beside its last
known neighbour, green in review for the writer to keep or drop. The frame's
deletions of rebased text never apply (`late_peer.stale_frame`, log-only): a reconnect
resends the client's whole delete set, and a replay is indistinguishable from the
first arrival, so acting on it would erase newer writing. Words the writer deleted
offline on rewritten text reappear, and they delete them again (D35): a browser reconnect resends offline
typing one keystroke per frame, so text typed and deleted again inside a rewritten
paragraph returns green, an accepted cost. Containment is checked first, so a clean
reconnect is a no-op that reports nothing.

Per-keystroke frames extend one recovered paragraph instead of starting another. The
coordinator keeps that memory in process (`LateTyping`, least recently used 64 drafts
in `branch-coordinator.ts`); a restart or eviction mid-reconnect starts a fresh
paragraph. Recovered typing is never deleted by a later frame. Any change to the
recovered block (text, marks or attributes) ends recovery's ownership of it: it is never
touched again and new typing beside it starts its own paragraph. A recovered paragraph
never shrinks.

Draft HTTP routes share `requireDraftWorkAccess`: a deleted Work is 404
`Draft not found` before any draft read or mutation. Archived Works still permit
review reads. The client draft-list query treats 404 as empty so a post-delete
catalog wake is silent.

Work draft capture, Apply and Discard require an active Work under the shared
lifecycle row lock before durable mutation, and take the row through
`lockSeamWorks` so bound edit grants are confirmed first
([file policy](../../file-policy/.context/CONTEXT.md)). An archived Work's drafts
are frozen: captured evidence stays, and nothing writes, applies or discards them
until unarchive. Replaying an already committed push returns its durable receipt
without reauthorizing a new write.

**Closing.** Discard is one kernel (`domain/draft-discard.ts`,
`adapters/drizzle-draft-discard.ts`): leases first (every branch of the draft for
Discard all; an item's branches and live document otherwise), then one transaction
locking the Work (active), the draft, the namespaces and the documents. It is
close-only: item Discard closes the item's text branch, Discard all closes the draft
and every branch, and neither resets text from live. Pending edit parts of a closed
branch become `discarded`. Either ends the draft's use of what it created,
tombstoning and releasing what no draft uses. Work purge runs the same kernel after
its own lifecycle proof. The kernel reports exactly the branches it closed or
deleted, and `domain/peer-retirement.ts` retires those rooms and (document, thread)
states after commit. No flow retires "every thread" on a document: agent-edit offers
`invalidateThreadDocument(doc, thread)` and `evictThread(thread)` only, so another
Work's staged reply on a shared document survives. The server closes a closed
branch's room with 4206 (`branch-closed`); a refused writer update closes with 4410
(`write-refused`), terminal on the client.

The only paths that may close a `work_draft` branch of an active draft are item
Discard, end of use, purge, and Discard all, all through the kernel;
`drafts.close` closes only the row. No idle close of empty text branches exists:
every live edit rebases each active text branch on the document, and `gc: false`
histories grow until Discard all, archive or purge.

A durable thread peer has no unpublished authored state: reply finalization saves
its edits into the shared text branch atomically. A thread-peer pull first rebases
the Work draft, then merges the draft's Yjs state into the peer; the peer always
contains its upstream, because a text branch only grows (a coordinator assertion
logs if it ever does not). Fresh drafted calls evict the previous reply's runtime
replica before rebuilding from the pulled peer. Calls already holding a staged
document keep that response's private edits.

Thread-peer resolution is primary-Work-aware. After conversation reassignment,
the old peer is no longer resolvable; a pull in the new Work's draft closes it
and seeds a new peer while holding the conversation row lock. Peers are made
only by pulls in an existing draft: a reply's save resolves exactly the peer
each document was pinned to (`InteractionContext.branchId`), under the leases
the pool took before the save's transaction, and refuses that document stale
when the pin no longer holds. Refusal reasons, in precedence: the draft is closed
(`discarded_draft`); the pinned text branch is closed and its document hidden, a
create nobody revealed (`discarded_document`); the pinned text branch is closed on
a live document, or the peer is closed under an active upstream (`discarded_edit`).
Closing a draft closes both kinds of its branches. The fencing lifecycle (pins,
the save's leases, confirmation under its locks) is `domain/reply-save-fences.ts`;
the pool (`domain/thread-peer-core-pool.ts`) routes and keeps reply records, and
`thread-peer-composition.ts` assembles it.

A reply that writes into text the writer already discarded locally commits with no
refusal: the words merge like any peer's, stay invisible when the discarded text
stays discarded, and `draft-write-visibility.ts` (a post-durability participant of
`response-write-finalizer.ts`) emits a `draft_write_invisible` notice. The writer's
receipt reads "Some of this reply's words went into text you discarded." and the
model's next turn gets the matching message.

The review list emits one item per document and folds all contributing chats into
it: `actorThreads` lists candidate chats; `itemKey` is the application and wire
identity of an item. The identity module resolves it to the physical text branch and
keeps that branch identity inside the domain; the room name is the only transport
address.

Writer commands are server commands, one `commandId` each. Apply (item, changes,
all) never closes the draft; the draft stays open after the last item applies.
Apply all and Discard all are one command each over the Work's whole draft, not a
client loop. A named-changes Apply on an item that is only a whole-document change
(a new, binary or live-deleted item) refuses `whole_item`. A resend of a used
`commandId` returns the recorded result, so a lost response cannot apply twice
([Settlement and trail](settlement-and-trail.md) has the rule).

Propagation is sync-only for thread peers. Cold attribution uses persisted branch
journal rows and live journal metadata; memory-only runtime maps are never an
attribution authority.

Live→text-branch rebases run after persisted live updates (2-second debounce,
10-second maximum), on branch review room open/reconnect, and at agent tool
boundaries. The room connect awaits `flushBranchLivePull` before the client's frames
are admitted (a stale room would otherwise refuse the writer's cumulative sync and
loop reconnecting); a failed pull is reported, not fatal. A room that is behind the
durable snapshot when a frame arrives catches up under the coordinator lock with
origin `branch-room-reconcile`, which `onChange` skips. Once durable, rebase deltas
use the branch coordinator's update publisher so loaded Hocuspocus branch rooms
converge and broadcast normally; unloaded branches are persistence-only.

Live checkpoints are a separate cadence from those pulls. They come from four
sources: the initialize-only seed (`up_to_seq = 0`); Hocuspocus
`onStoreDocument` at `debounce: 2000` / `maxDebounce: 10000` plus last-client
disconnect; explicit `CollabDomain.checkpoint`; and `journal.compact`. Compaction
is implemented but has no production caller, so live journal rows are never
deleted.

**Releasing a live room never waits on a database lock.** Closing the last
connection runs `onStoreDocument` inline in the releaser's async context, often
inside its DB transaction. The hook therefore only queues the room's immutable
authority binding. After the releaser's transaction commits, the worker captures
a durable checkpoint cut under the document mutation lock and persists it in
a separate transaction. Rollback drops the request; a retired generation
cannot capture or persist a cut. Requests queue one per document, newest request
wins; shutdown drains them. A checkpoint only caches durable journal state,
so a dropped or late one costs
replay time, never data. Thread-peer pulls also take their live snapshot outside
the caller's transaction, so loading the room cannot leave head or lock rows held
by a caller that then waits on the root pull transaction.

**Branch mutations are durable before they reach a Hocuspocus room.** A draft
branch room is a collaborative room: writer frames from a review editor are
admitted like any other peer's, alongside server-side agent and disposition
commands. No branch-room `onStore` path may re-persist or re-checkpoint to make
a mutation durable; it already is. Live and branch writer frames use the same
sequence: authority/generation validation, exact-containment acknowledgement,
fresh-authorship validation, then durable append. Branch admission runs that
sequence against one locked branch snapshot through the awaited `beforeSync`
hook, before Hocuspocus apply/broadcast/ack. `onChange` does not own branch
persistence. `admitBranchWriterUpdate` registers the whole admission with
`trackAppend` before validation's first `await`, so a `storeHocuspocusBranch` or
graceful-shutdown drain cannot miss an admission Hocuspocus is already
processing; do not move registration after an `await`.
`storeHocuspocusBranch` only drains pending branch admissions; taking branch
leases from it (any `withBranches`) re-enters the publisher's
`AsyncLocalStorage` branch-lock context and throws (`branch-critical-sections.ts`
rejects overlap on sight).

The Yjs route owns only upgrade authentication, CrossWS peer adaptation, and
gateway delegation. `lib/yjs-ws-handler.ts` owns connection state, admission,
Hocuspocus lifecycle hooks, and graceful drain; transport changes must preserve
the admission ordering above and keep `beforeSync` awaited. The gateway is a
synchronous process singleton: authenticated upgrade captures it in the peer
context, and `open`/`message`/`close`/`error` must dispatch through that
instance without a lookup `await`. Startup retains that same instance so
shutdown calls `drain()` before its first await; `drain()` closes admission
synchronously before waiting for persistence.

The coordinator keeps a bounded LRU of branch replicas (32): eviction skips dirty
and pinned entries, and composition disposes replicas at shutdown after in-flight
pulls finish.

## Certified provenance materialization

**Ordering invariant:** declaration order in `ir.intent.edits` is not application
order. A `textRanges` edit applies its same-block replacements right-to-left
(`applyInlineReplacements`);
partitioning allocation-ordered strings by iterating declared edits swaps
provenance roots between adjacent targets. The writer instead locates each edit
by its final output span and intersects that span with newly inserted strings.

**Regression trap:** hand-performing Yjs mutations in IR declaration order does
not exercise this seam. Provenance ordering tests must compose the real
`applyEdits`.

For a certified whole-block structural carry, lowering tombstones the input
block before provenance materialization. The writer may locate its output only
through one adjacent visible replacement block whose entire prose belongs to
the current lowering and matches the certified output length. Partial, absent,
or multiple matches fail closed through the length-conservation guard; rendered
text equality is never continuity evidence.

Restoration length is validated independently at both the certification and the
writer boundary; neither check assumes the other ran.

## Membership

An item is listed (`isListed` in `domain/draft-review-items.ts`) when:

- the draft **created** its document (text not required; images included); or
- it is an **edited** item whose active text branch has `has_effect OR blocking`.
  A writer-only edit lists, and a write followed by its revert lists nothing.
  `blocking` stays so an inverse hold keeps the item reachable.

Folders are not items. A text branch with no effect stays addressable and
unlisted, so its next proposal keeps the same room.

`listedItemRelation` in `adapters/drizzle-branch-push.ts` is the predicate's one
SQL twin: the active-draft join, the edited arm and the created arm
(`draft_tree_changes`), keyed by draft, Work or document. Every SQL consumer
selects from it and never rebuilds an arm, so the list and the counts cannot
drift:

| Consumer | Reads |
|---|---|
| Wire list (`work-draft-review-service.ts`) | the predicate over the tree-merged items |
| Apply resolution (`draft-publication.ts` `applyItems`) | the resolver, which is addressability not listing |
| Pending counts and the document hint (`WorkDraftPendingStore`, adapter in `drizzle-branch-push.ts`) | the relation; counts are distinct pending documents per Work |
| Work projection and catalog count | the same counts |
| Chat strip (`GET /api/threads/:threadId/draft-files`) | the relation, restricted to items whose `actorThreads` include the thread: pending AI parts on the text branch, or the creating chat (`draft_tree_changes.created_thread_id`) |

Apply resolves refs through the resolver, so an item the writer emptied locally
after the list rendered (unlisted but present) plans normally, usually
`already_live`; only an unaddressable item makes the command `stale`. Route grants
for Apply all and Discard all come from the resolver over the request's refs or
every addressable item, so an emptied, unlisted item still gets its grant.

`domain/document-creation.ts` owns tracked-document materialization transactions.
Context and bootstrap supply the row and initial content. They commit together;
warm-room publication follows the enclosing transaction's commit. Tree presence
comes from context's tree views, never a Yjs manifest.

## Durable records

- `document_yjs_updates` is the live update journal.
  Writer rows persist as `origin_type = human`; reads also normalize legacy
  `user` rows to the package's `human:<actor>` origin. Model inverses use agent
  attribution. Bookkeeping rows use `system`. Settlement appends one `reconcile`
  row per applied content member carrying the merged text's replay coverage, not a
  new semantic edit. Immutable edit parts and certified aliases own reversal
  correspondence.
- `document_branches` stores branch snapshots, state vectors, `has_effect`,
  `blocking` and `base_revision`.
- `branch_write_journal` stores branch write rows (agent and writer) and their
  status; Apply no longer marks rows `pushed`.
- `push_lineage` stores publication identity and idempotency lineage, and for a
  content member its frozen request in `apply_payload` (`ContentMemberInput`).
  `journal_ids` stays `NOT NULL`; content rows write `'{}'`. The change trail is
  the sole durable publication record; lineage never duplicates block diffs.
- `draft_commands` stores one row per writer command and its terminal result,
  kept for the Work's lifetime. A historical `discard_changes` kind stays valid as
  stored; nothing writes it.

Human-origin edits produce one journal row per keystroke. A 50-character
sentence becomes ~50 rows / ~935 bytes. Journal row counts are not equivalent
to semantic edits. Checkpoint compaction would recover the storage, but it has
no production caller.
Reconnect frames already contained by the live document are acknowledged but
do not enter the journal or trigger post-persistence hooks.

Novel live sync-step-2 integration is the offline-reconciliation hook. It
captures the converged state before asynchronous persistence work, replays the
durable journal for origin and structural-delete attribution, and reports each
removed writer-owned canonical block identity. Missing ancestry/body/owner
evidence emits degradation telemetry rather than guessing from update bytes;
it does not make the optional mark overlay authoritative.
