# Frozen text Apply

`domain/apply-click.ts` compiles a click from a contained snapshot of a gc-off
committed draft. It retains the schema with the frozen optimistic base and
patched blocks: independently built schemas have distinct node/mark types and
cannot be mixed in the merge kernel. Receipt membership is classified at that
cut, not replayed onto live. Unknown groups refuse before any command claim.

The command lookup precedes resolution, validation and every fresh refusal.
The whole envelope and body are digested. A committed result wins even after
the draft closes; a duplicate that loses the unique claim rolls back before
reading the winner. Pending commands are observations, not a second scheduler.

`adapters/drizzle-apply-click.ts` owns the atomic storage operation. The Works
boundary locks the Work and confirms the route's bound edit grants before the
first write (the command claim). A hidden-create reveal verifies its tree namespace before taking live's
mutation lock. A source moving during that acquisition rolls back and retries
the transaction, without re-compiling the click. Ordinary text Apply takes only
live's mutation lock, so unrelated tree changes do not serialize it. Live is
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

The API-core recipe is [atomic Apply](../../../../../../docs/qa/atomic-apply.md).
It uses a scratch database and the real route core, file policy, command store,
append door and trail writer. It does not stand in for integrated browser FIFO
and optimistic-review verification.
