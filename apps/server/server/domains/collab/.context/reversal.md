# Collab — reversal contracts

Two inverse paths use the forward-inverse primitive in `@meridian/agent-edit`
over immutable edit parts: the model's `write revert` and failed-response
rollback. An inverse is an ordinary immutable journal edit; it never rewrites a
target row or marks it reversed. The writer's undo is not an inverse edit: a
Discard is a local edit of the draft text, owned by the client (see
[draft review](../../../../../../apps/app/src/features/draft-review/AGENTS.md)).
There is no card Undo/Redo, no model `write undo`/`write redo`, and no reversal
routing, table or reserved client.

## Commands and policy

`write revert {path, edit}` targets one immutable edit by handle;
`read(format: "edits")` pages the thread's own edits. It writes into the thread's
current destination: the active draft's text branch (ensured and freshly seeded
if absent) or live. It writes ordinary journal rows with pending parts, so in a
draft it shows as a change the writer applies. It reverts the parts and blocks the
writer left alone and reports the rest ("revert 1 of 2"); with nothing left it
refuses `nothing_to_revert`, and an archived draft refuses `work_archived`.

Rollback (a failed reply) selects by edit scope (`ModelResponseIdentity`) and
records accepted parts as terminal `rollback` edits; parts already `discarded` or
rolled back are skipped, and only an uninvertible pending target keeps
`rollback_pending`. A repeated rollback appends nothing. A failed checkpoint or
report cannot reject a durable save.

Stored `undo` and `redo` edit kinds stay readable for old rows; nothing writes
them, and model edit entries and response-scoped discovery exclude them. A turn's
edit targets exclude tombstoned documents (`documentNotDeletedSql`), so a
discarded draft-created document is never an inverse target.

Placements are `pending`, `live` or `discarded`. Content Apply moves no part: edit
status is derived from the draft's text (`draft-edit-status.ts`: applied when the
part's text lies in no review change, pending inside one). Item Discard and
Discard all make the closed branch's pending parts `discarded`.

## Holds, effects, and failures

A pending inverse holds the roots whose draft identity differs from live. Holds
and destinations are branch-scoped and prepared from one locked invocation view;
a skipped hold marks its draft `blocking` so the item stays listed when its text
equals its base.

A draft inverse writes through `writeBranchState` with the text effect, inside
the Work projection mutation, so the Work page sees an effect change in the same
transaction. Publication is deferred until after commit (a live inverse recovers
the live room, refreshes the projection and flushes the rebase; a draft inverse
broadcasts to the branch room). Inverses take sorted transition locks,
branch/live process locks, Work rows, then ordinary admission locks; Apply does
not take the transition lock. Root pulls must not be awaited while holding Work
locks. Restoration correspondence comes from certified aliases on immutable
parts, never equal text.

## Status reads and locking

| Caller / entry point | Classification | Snapshot and lock contract |
| --- | --- | --- |
| `model-inverse-policy.modelEdits` → `partsInChanges` (the only production caller) | Read-only | Capture encoded live journal updates, branch states, edit parts and Work metadata under the inverse/branch/live/Work/admission locks. Release the capture's root transaction and process locks before materializing status Y.Docs, planning availability, diffing or rendering. |
| `model-document-edits.createModelDocumentEdits.read` → `modelEdits` | Read-only | Returns the captured status page; never writes from its status. Destination provisioning may ensure a draft before the read, independently of status. |
| agent-edit `createDocumentEditCommands` → `DocumentEdits.read`, reached by the runtime's `read(format: "edits")` tool (including paged reads) | Read-only | Returns status and revert availability as advice, with the revision of the captured read. The later revert reads again. |
| `model-inverse-policy.modelInverse` (`write revert`) | Read-then-write; **does not call either status reader** | `prepareHolds` / `prepareEditRoots` classify and select parts, then commit under the original locked invocation. Never uses cached availability. |
| `turn-inverse-service.rollbackResponse` (failed reply) | Read-then-write; **does not call either status reader** | Selects and computes inverse parts, marks holds, then commits under the original locked invocation. |
| Ordinary chat-turn context preparation | No call to either status reader | A chat can explicitly call the edits read tool; ordinary context construction does not. Concurrent-chat acknowledgement delays can therefore have other causes. |
| `draft-edit-status.test.ts` | Read-only test calls to `partsInChanges` | Exercises the pure classifier directly, without a cache or storage locks. |

`withReadDocuments` owns the captured Y.Docs and destroys them after the read,
including on failure. It opens a root capture transaction so SQL locks cannot
leak into the subsequent projection through an ambient caller transaction.
The captured branch bytes are already encoded by storage; capture does not
re-encode a room or clone its Y.Doc. Write paths retain `withLockedDocuments`:
the same capture is materialized and consumed **inside** the locked transaction.

`modelEdits` caches the complete rendered status page, including revert advice,
in a service-owned 16-entry LRU keyed by the SHA-256 digest of the read's full
state key; only messages over 65,536 UTF-16 code units stay uncached. Never key
by the raw snapshots: a 50k-word rewrite's snapshot is ~260 KB, so the drafts the
cache exists for would never cache. The key contains the caller thread/turn, destination and page,
document identity/URI, every branch ID with its name/frozen flag, the live and
every draft's encoded Yjs snapshot, and the ordered immutable edit-part IDs
with their mutable placements and nullable thread/turn foreign keys. Within each lineage Yjs structs and edit parts
are immutable; the snapshot includes both their clock frontier and delete set.
Thus deletion-only edits, moves, Undo/restoration links, Apply base patches,
new/rolled-back parts, placement or thread/turn deletion changes, and a different page all invalidate
when they can change the answer. No cache entry contains a mutable Y.Doc.
The response's `revision` is that same digest, an opaque label for the
captured read, not a write precondition. Every revert reclassifies current truth.
