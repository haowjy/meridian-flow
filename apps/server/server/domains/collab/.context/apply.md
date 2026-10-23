# Frozen text Apply

`domain/apply-click.ts` compiles a click from a contained snapshot of a gc-off
committed draft. It retains the schema with the frozen optimistic base and
patched blocks: independently built schemas have distinct node/mark types and
cannot be mixed in the merge kernel. Receipt membership is classified at that
cut, not replayed onto live. Unknown groups refuse before any command claim.

The command lookup precedes resolution, validation and every fresh refusal.
The whole envelope and body are digested, including the stable `draftId` captured
with text clicks. That exact draft must belong to the addressed Work and document;
a replacement draft never inherits an old click. Identity and closure are rechecked
inside the atomic boundary. A committed result wins even after
the draft closes; a duplicate that loses the unique claim rolls back before
reading the winner. Pending commands are observations, not a second scheduler.

`adapters/drizzle-apply-click.ts` owns the atomic storage operation. The Works
boundary locks the Work and confirms the route's bound edit grants before the
first write (the command claim). A hidden-create reveal or a deleted document's
restore verifies its tree namespace (`acquireTreeScope`) before taking live's
mutation lock. The scope comes from an unlocked tree read, so Apply re-reads under
the lock: a delete that landed in between, or a source moving during the
acquisition, rolls back and retries the transaction namespace-first (remembered
for every later attempt), without re-compiling the click and never taking a
namespace under a document lock. Ordinary text Apply takes only live's mutation
lock, so unrelated tree changes do not serialize it.

A document deleted live whose draft outlived the delete (D79) comes back only
when the writer knew it was deleted: the click carries `restore: true` (a
per-document Apply on an item showing the deleted state, or an Apply all for the
documents its confirmation named). The check runs under the document lock, so a
delete the writer's view did not show, however late it landed, answers
`needs_restore`: nothing changes, the draft stays pending, and the client asks
before sending a new click with `restore`. The answer is stored, so a replay
returns it. With `restore`, `restoreDocument` clears the record and restores its
folders in the same transaction, then the ordinary text merge runs against the
deleted document's last text, which equals its review base. The result carries
`restored: true`. A path another document took makes the restored document land at the next
free name and adds a `renamed` note; a Work cascade, discard or deleted source answers `closed`
(no record on the answer). The route authorizes a deleted item at its source through the
draft destination (`restoreGrant`) instead of a live grant. When a delete commits
after the route resolved the item, its authorization or the transaction's grant
confirmation refuses the live grant, nothing is claimed, and the route runs the
click once more (once), which resolves the item as deleted. Apply reads the
addressed document's own lifecycle row for these decisions, never a branch-wide
tree listing. The append
door is the sole draft-row lock and active-state check: live preparation and its
staged journal write precede it inside the same Work transaction. A late draft
closure unwinds that whole transaction before answering `closed`, so no live
half or claim escapes admission. Draft/document/Work identity is bound by the
addressed load and never changes during a draft's lifetime. Live is
read from the committed checkpoint and journal under its mutation lock, never
from a room. A still-hidden creation is revealed through the tree's placement
kernel, and its arrival and catalog changes join the same transaction.

The draft half uses `prepareAppend` with no incoming rows. Its server author
runs once on the locked committed prefix as client 1. Each selected group writes
its own `applyBase` result and Apply record, and the adapter stores that group's
actual base before/after plus its immutable live-part sequence. It leaves
`prosemirror` untouched. A failure after either half throws: the live journal,
base, record, lineage, trail and claim all roll back. Installation and live
recovery wait for the root commit through the existing append lifetime.

Editor Undo sends an `unapply_click` command for the original Apply command. The
Apply store resolves those per-group receipts after the document mutation lock,
uses the forward-inverse kernel directly against live history, and folds only
the successfully reversed groups out of the current review base. A group edited
later in live is skipped. A null live receipt removes its Apply record without
changing live or base. Tree effects are never selected. The inverse, base fold,
record removal, effect settlement, and command result commit together; delivery
and pull flushing begin only after that commit. This path does not use the
model/turn reversal planner.

Trail changes compare the actual live before/after identities and visible
content, with navigation built from the committed result. Owners are the
selected groups' receipt members, not draft journal playback. Compilation
keeps each selected hunk's support in P and fully removed base blocks. The one
actual live rebase's correspondence joins that support to committed output and
removed live identities, then intersects with the actual live changes. The
whole-click owner union is only for signaling, never passage attribution.
The Apply answer's `overrode` comes from the kernel, not the conflict report.
Apply explicitly
signals each owner turn and shared conversation after recording its trail.
Migration 0076 removes push-journal, placement and settlement ownership reads
from the installed signal functions; ordinary row signals retain JIT off.

`apply.measured` emits compile and Work-boundary times by command id. The append
door's lock-to-root-commit `holdMs` is associated with that command through an
async diagnostic scope; server-author CPU time is not reported as row hold time.
There is no earlier draft lock outside that door to hide part of Apply's hold.

The API-core recipe is [atomic Apply](../../../../../../docs/qa/atomic-apply.md).
It uses a scratch database and the real route core, file policy, command store,
append door and trail writer. It does not stand in for integrated browser FIFO
and optimistic-review verification.

## The tree cut

A click may carry `tree: { revision }`, the revision of the branch's
`branch_tree_changes` row the writer saw (`ThreadDraftListItem.tree`). A click
applies exactly its cuts: tree alone (a move-only or delete-only item, or a
creation with no text room: empty `groupIds`/`baseViewDelta`, no `snapshot`),
text and tree (the whole item: tree first, then the text merge at the result),
or text alone, which leaves a pending move or delete pending: a hidden creation
is revealed at its own row, since text can't land in a document live lacks, and
the branch's row loses only `created` (`endCreatedFact`, a new revision), so its
move or delete stays a pending tree line on the now-live document. A tree cut takes the
tree scope with the branch's placement and locks the branch; under the locks a
row at another revision answers `changed` and nothing applies.

The operation is keyed on the row's logical state and live's state:

| State | Live | Apply |
|---|---|---|
| deleting | living | `DocumentRemoval.remove` (writer actor); the branch's draft closes |
| deleting | hidden creation | end of use (`tombstoneUnused`) |
| deleting | deleted | settle only, no restore and no `needs_restore` |
| moving | living | `moveToPlacement` to the effective placement |
| moving | deleted | `restoreDocument` at the effective placement (needs `restore`, D79) |
| moving | hidden creation | reveal at the effective placement |
| created | hidden | reveal at the row |

A move whose destination live still gives a document this branch moves or deletes follows the
single occupant chain under the branch lock and applies it dependency-first. Each dependency
uses a savepoint, so an impossible destination leaves that dependency's tree fact pending while
the clicked document may still take the next free leaf name. It does not apply dependency text
because no frozen click exists for that text; a drafted delete necessarily closes its draft. A
terminal cycle moves together, so swaps keep both requested names. Any unrelated leaf occupant
keeps its name and the arriving document takes the next free name. The result carries each
settled item's committed before and after address and attaches a `renamed` note when it yielded.
If a document occupies an ancestor where the destination needs a folder, Apply answers the
specific `ancestor_taken` refusal; leaf allocation never uses that path.
Then each row goes through `dropDocumentRows`,
which writes the settlement rows every terminal path writes (`as: applied` for the
entries in effect, `discarded` for those undone before it), and
prunes every hidden folder its moves held that nothing else uses. The route authorizes a drafted
delete of a document live deleted too through `restoreGrant` alone: the branch
view has no draft of it to grant.
