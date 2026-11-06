# Collab — committed change trail

Apply records its committed live effect without replaying draft journal rows onto
live: receipt classification supplies ownership, and canonical live before/after
identities supply navigation.

The aggregate's readiness is terminal-turn and `rollback_pending`. A trail shell's
building/settling/settled lifecycle is delivery state, not an Apply settlement batch.
Reconciliation consumes exactly the dirty signals in its cut, under sorted aggregate
locks. Sequence allocation is not commit order. Delivery follows commit, through the
trail dispatcher's outbox; once the journal append commits, the outbox row is deleted in
that same transaction. The shell keeps its counts, document summaries and word totals
because document details are manuscript-bearing and cascade when a document is purged.

Trail detail authorization precedes manuscript-bearing materialization. Denied
occurrences disappear; authorized deleted anchors keep their evidence. Durable
identity is a canonical live block identity, not equal text, a display hash or an
ambiguous relocation chain.

Journal and receipt signal triggers run inside an append's draft row hold, so
`change_trail_owners` keeps JIT off and primary-key journal lookups, and does no
push-journal, placement or settlement ownership reads. Apply signals all selected
member owners explicitly. A tree entry has no parts: `change_trail_owners` follows
`tree_change.targets` and `tree_change.settles`, and the receipt trigger fires for
it, so a card Undo of a move dirties the turn that made it.
