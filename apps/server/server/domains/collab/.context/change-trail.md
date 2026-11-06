# Collab — committed change trail

The trail worker projects every committed live AI effect, including Apply, from
immutable receipts. It owns details, counts, occurrences, lifecycle and delivery;
no journal append or Apply transaction invokes a trail projector. A document edit
commits independently of trail availability.

## Source and ownership

A live receipt part's `origin.checkpointId` pins the exact authority generation and
its complete base. Reconstruction merges immutable live receipt bytes with retained
transport updates in admission sequence and part order. Compaction deletes a
transport row only when a receipt retains its bytes; checkpoints remain until
document purge, including an empty genesis referenced by a receipt. State vectors
alone cannot reconstruct historical deletions. Missing source evidence fails that
owner's projection and preserves its signals rather than settling an empty trail.
Existing receipts without a checkpoint reference are not assigned an invented cut.

Apply stores each group's contributing owners on `apply_command_effects.owners`.
This is bounded source evidence, retained after Un-Apply and draft release. Its live
journal writes already produce receipts. The worker attaches those owners and the
admitting push to the same receipt projection used for direct live edits. A null
owners column denotes historical missing evidence; an empty array denotes a group
with no AI contributor. Un-Apply explicitly dirties the affected owners.

Writing threads resolve through `resolveEditOwners` to the nearest primary chat
and its spawning turn. A primary write without a turn belongs to that chat's shared
trail. An inverse inherits ownership from each exact targeted receipt part, rather
than from every part in its edit. Restoration aliases retain canonical block
lineage through Undo and Redo. Replaying the complete owner cut folds reversals into
the net trail: a full Undo removes details and advances an empty occurrence
replace-set to clear live marks. Folding compares text bodies independently of
display hashline prefixes, which can change when an unrelated sibling is inserted.

## Projection and delivery

Reconciliation pages dirty owners and unfinished shells. Each canonical owner has
its own repeatable-read root transaction and aggregate advisory lock. The worker
never holds a document mutation lock. It consumes precisely the visible signals,
replaces the owner's projection, advances occurrences, and writes shell/outbox
versions atomically. A failure rolls that owner back; other owners and later pages
still progress. Sequence allocation is not commit order, so a lower signal sequence
committed after the cut remains work for the next pass.

Readiness is terminal-turn and absence of canonically owned `rollback_pending`
rows. Building/settling/settled is delivery state. Settling remains observable for
one polling pass. The dispatcher treats the outbox as pending work: once the journal
append commits, the outbox row is deleted in that same transaction. The shell keeps its
counts, document summaries and word totals because document details are manuscript-bearing
and cascade when a document is purged.

Trail detail authorization precedes manuscript-bearing materialization. Denied
occurrences disappear; authorized deleted anchors retain their evidence. Durable
identity is a canonical live block identity, not equal text, a display hash or an
ambiguous relocation chain.

Journal and receipt signal triggers run inside an append's draft row hold, so
`change_trail_owners` keeps JIT off and primary-key journal lookups, and does no
push-journal, placement or settlement ownership reads. Apply signals all selected
member owners explicitly. A tree entry has no parts: `change_trail_owners` follows
`tree_change.targets` and `tree_change.settles`, and its receipt trigger dirties the
turn that made it when a card undoes a move.
