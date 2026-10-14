# Collab — branch model and durable records

## Vocabulary

Five names that look alike and are not. Code, docs and wire types keep them apart.

| Name | Is | Owner | Crosses the wire as |
|---|---|---|---|
| **draft** | The Work's one active draft (`drafts` row). Closes only on Discard all and purge; Apply never closes it. | the Work-draft lifecycle (`shared/work-draft-lifecycle.ts`) | `draftId` |
| **branch** | One document's text Y.Doc of a draft (`document_branches`, kind `work_draft`, keyed `(documentId, draftId)`) plus the thread peers that fork from it. Same id across resets; its generation moves up. | the branch store and peer pool | never; only `branchGeneration` and the opaque `reviewRoomName` |
| **item** | One document's reviewable change in the draft, with or without a branch (an empty create, a created image). | `domain/draft-review-identity.ts` (the one module that maps item to branch) | `itemKey` = `${draftId}:${documentId}` |
| **command** | One writer action: item or per-change Apply or Discard, Apply all, Discard all. Idempotent under its `commandId`. | the review service and command records | `commandId` |
| **presented address** | What the writer is looking at: `{ workId, itemKey, changeId? }` (URL `item=` and `change=`, dock persistence). Names no branch. | the client | the API review selector `reviewWorkId` + `itemKey` |

```text
Work 1──1 active draft 1──* item ──0..1── branch 1──* thread peer
                              │                  │
                              │                  └ room: branchRoomName(branchId, generation)
                              └ presented address (workId, itemKey) ─ command (commandId)
```

An item with no branch still resolves, lists and applies. The server resolves
every `itemKey` through the identity module; no function takes a bare string
that may be a draft id, a branch id or an item key.

## Branch model

Branches are real Y.Docs. A thread peer starts from the Work draft, receives live
pulls by CRDT sync, and stages agent writes. The Work draft is the writer review
branch. There is at most one active Work-draft branch per
`(documentId, draftId)`; every thread peer for that document and draft shares it
as upstream and carries the same `draft_id`. A branch's Work is its draft's
origin Work, read only through `draftBranchWorks`/`branchDraftWork`
(`shared/work-draft-lifecycle.ts`); a draft with no origin Work is frozen. Pushing computes a Yjs update from branch to live, records push
lineage, marks source journal rows reviewed, and resets/advances branch
generation where needed.

Draft HTTP routes share
`requireDraftWorkAccess`: a deleted Work is 404 `Draft not found` before any
draft read or mutation. Archived Works still permit review reads. The client
draft-list query treats 404 as empty so a post-delete catalog wake is silent.

Work draft capture, redo, Apply and Discard require an active Work under the
shared lifecycle row lock before durable mutation, and take the row through
`lockSeamWorks` so bound edit grants are confirmed first
([file policy](../../file-policy/.context/CONTEXT.md)). An archived Work's
drafts are frozen: captured evidence stays, and nothing writes, applies or
discards them until unarchive. Replaying
an already committed push returns its durable receipt without reauthorizing a
new write. Discard is one kernel (`domain/draft-discard.ts`,
`adapters/drizzle-draft-discard.ts`): leases first (every branch of the draft for
Discard all; an item's branches and live document otherwise), then one transaction
locking the Work (active), the draft, the namespaces and the documents. An item's
text resets from live; Discard all closes the draft and every branch instead. Either
ends the draft's use of what it created, tombstoning and releasing what no draft
uses. Work purge runs the same kernel after its own lifecycle proof. The kernel
reports exactly the branches it closed (an item's reset branch's peers) or deleted (a
tombstone's), and `domain/peer-retirement.ts` retires those rooms and (document,
thread) states after commit; the review preview's corrupt-branch reset does the same
for the reset branch's peers. No flow retires "every thread" on a document: agent-edit
offers `invalidateThreadDocument(doc, thread)` and `evictThread(thread)` only, so another
Work's staged reply on a shared document survives. Branch reset notifications publish
after commit; rolled-back resets never advance a room.

A durable thread peer has no unpublished authored state: reply finalization saves
its edits into the shared Work draft atomically. Before a new call, a pull tests
whether the parent contains the peer's full update, including deletes. If review
retired peer effects, the coordinator resets that peer to the parent instead of
merging stale structs or tombstones back in. Fresh drafted calls also evict the
previous reply's runtime replica before rebuilding from the pulled peer. Calls
already holding a staged document keep that response's private edits.

Thread-peer resolution is primary-Work-aware. After conversation reassignment,
the old peer is no longer resolvable; a pull in the new Work's draft closes it
and seeds a new peer while holding the conversation row lock. Peers are made
only by pulls in an existing draft: a reply's save resolves exactly the peer
each document was pinned to (`InteractionContext.branchId`), under the leases
the pool took before the save's transaction, and refuses that document stale
when the pin no longer holds (closed peer, reset or closed draft branch, closed
draft). Closing a draft closes both kinds of its branches. The fencing lifecycle
(pins, the save's leases, confirmation under its locks) is
`domain/reply-save-fences.ts`; the pool (`domain/thread-peer-core-pool.ts`)
routes and keeps reply records, and `thread-peer-composition.ts` assembles it.

The review list therefore emits one active item per document and folds all
contributing journal rows into that item. `actorThreads` lists candidate chats;
`itemKey` is the application and wire identity of an item. The identity module
resolves it to the physical Work branch and keeps that branch identity inside
the domain; `reviewRoomName` remains an opaque transport address.

Writer commands are server commands, one `commandId` each. Apply (item,
per-change, all) never closes the draft; the draft stays open after the last
item applies. Apply all and Discard all are one command each over the Work's
whole draft, not a client loop. A per-change command on an item that is only a
whole-document change (a new document) refuses `whole_item`. A resend of a used
`commandId` returns the recorded result, so a lost response cannot apply twice.

Propagation is sync-only. Cold attribution uses persisted branch journal rows
and live journal metadata; memory-only runtime maps are never an attribution
authority.

Review operations keep two internal journal-row identities separate.
`SourceUpdateIds` name the logical source rows used for operation attribution
and presentation; `PhysicalSourceUpdateIds` name every physical row needed to
replay a review class, including invisible suppliers and certified inverse rows.
`closureUpdateIds` is the shared physical set for per-change Apply and Discard.
Classes union visible hunks, shared physical rows, Yjs origin/rightOrigin/parent
references, delete-set overlaps, and same-client clock-prefix edges. Even unrelated
visible edits can be inseparable when one Yjs client supplied both. Draft review
editors rotate the writer client before an edit in a different closure class or
a disjoint untouched location. Continuous typing and edits within one class
keep their client; a pause alone never rotates. Writer room admissions retain
transaction deltas, not state-vector diffs (which echo cumulative deletions).
Rotation does not remove genuine structural dependencies or split retained rows. Neither identity is wire data, and callers must not substitute one for the
other just because both are represented by numbers at runtime.

Live→Work-draft pulls run after persisted live updates (2-second debounce, 10-second
maximum), on branch review room open/reconnect, and at agent tool boundaries. The
room trigger is fire-and-forget; Hocuspocus admission never waits for the pull. Once
durable, pull deltas use the branch coordinator's existing update publisher so loaded
Hocuspocus branch rooms converge and broadcast normally; unloaded branches remain
persistence-only.

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
a mutation durable — it already is. Live and branch writer frames use the same
sequence: authority/generation validation, exact-containment acknowledgement,
fresh-authorship validation, then durable append. Branch admission runs that
sequence against one locked branch snapshot through the awaited `beforeSync`
hook, before Hocuspocus apply/broadcast/ack. `onChange` does not own branch
persistence. `admitBranchWriterUpdate` registers the whole admission with
`trackAppend` before validation's first `await`, so a `storeHocuspocusBranch` or
graceful-shutdown drain cannot miss an admission Hocuspocus is already
processing — do not move registration after an `await`.
`storeHocuspocusBranch` only drains pending branch admissions; calling
`checkpointBranch` (or any `withBranches`) from it re-enters the publisher's
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

## Pending publication

The `WorkDraftPendingStore` port (Drizzle adapter in `adapters/drizzle-branch-push.ts`)
owns the pending Work-draft predicate used by review lists, counts, and
Auto-apply confirmation: current-generation reviewable rows, one joined query
that projects only `turnId`. Counts are distinct pending documents per Work: the
active draft's branches with reviewable rows plus its change rows (a created
document is pending with no text yet), never raw journal-row totals. The review
list (`domain/draft-review-items.ts`) is the draft's tree state merged with those
branches; Apply is `domain/draft-publication.ts`.

`domain/document-creation.ts` owns tracked-document materialization transactions.
Context and bootstrap supply the row and initial content. They commit together;
warm-room publication follows the enclosing transaction's commit. Tree presence
comes from context's tree views, never a Yjs manifest.

## Durable records

- `document_yjs_updates` is the live update journal.
  Writer rows persist as `origin_type = human`; reads also normalize legacy
  `user` rows to the package's `human:<actor>` origin. Card inverse journal rows use
  `system`; their immutable inverse receipt carries the writer actor. Model
  inverses use agent attribution. Bookkeeping rows also use `system`. Settlement appends exact authored rows followed by one
  `reconcile` row carrying canonical replay coverage, not a new semantic edit.
  Immutable edit parts and certified aliases own reversal correspondence.
- `document_branches` stores branch snapshots/state vectors/generation.
- `branch_write_journal` stores branch write rows and review status.
- `push_lineage` stores publication identity, typed branch generation, and
  idempotency lineage. The change trail is the sole durable publication record;
  lineage never duplicates block diffs.

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

### Preview interleave semantics

`mergeArtifact` identifies surviving insertion structs whose Yjs origin and
right-origin both lie in context deleted by the other author. Ordinary writer
insertions inside intact AI prose keep their author-specific spans, even with
multiple writer runs. A diff hunk can be writer-only while its deleted origin
belongs to an adjacent AI rewrite. Run alternation is not the authority.

Text hunks with `deletedText` also emit `deletedSpans`: ordered, disjoint UTF-16
`from`/`to` offsets covering the full removed string, each with `deletedBy`
(`agent` or `writer`). Authors come from deletion attribution, not inserted
spans or the hunk's owning operations. A single semantic deletion can contain
both authors. This field carries no journal row identifiers. Block-display
hunks keep their existing contract. Cumulative delete-set visibility is checked
per Yjs struct, so old tombstones cannot hide a newly deleted neighboring region.

A removal of a whole live block names it: a deleted block hunk's `deletedBlock.blockId`
and a text hunk's `deletedBlockId` are the live block's Yjs item (`blockItemKey`,
`client:clock`). A draft re-forked from live keeps that item when the deletion is
discarded, so a client holding the old review can find the restored block by it.
