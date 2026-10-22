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
`restored: true`. A path another document took refuses `forbidden` (the item
lists `path_taken`); a Work cascade, discard or deleted source answers `closed`
with the record. The route authorizes a deleted item at its source through the
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
runs once on the locked committed prefix as client 1: one transaction writes
`applyBase` to `review_base` and appends the command's Apply record. It leaves
`prosemirror` untouched. A failure after either half throws: the live journal,
base, record, lineage, trail and claim all roll back. Installation and live
recovery wait for the root commit through the existing append lifetime.

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

A still-hidden creation with no text draft uses empty `groupIds`/`baseViewDelta`
and omits `snapshot`. The same transaction claims its command, rechecks hidden
creation and no-room identity under the tree/live locks, reveals it and clears
its branch rows. No room, Apply record or text lineage is fabricated. Empty
groups on any other item are malformed.
