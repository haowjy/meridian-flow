# Collab — committed change trail

The staged Apply/settlement pipeline is deleted. There is no pending settlement
store, contribution replacement/refinement, seed parser, owner reopening,
worker recovery call, ingress barrier or offline-reconciliation service.
Atomic Apply records its committed live effect without replaying draft journal
rows onto live. Receipt classification supplies ownership; canonical live
before/after identities supply navigation. See [Apply](apply.md).

`DurableTrailRecord`, normalized committed changes, aggregate persistence,
authorized reads/navigation, dirty signals and the delivery outbox remain.
`draft-trail-projection.ts` retains live identity comparison/navigation and
committed record persistence, not journal-attribution reconstruction.
`document-difference.ts` compares only committed live block identity and visible
content.

The aggregate keeps terminal-turn and `rollback_pending` readiness. Pending
Apply settlement no longer blocks it. Trail shells' observable
building/settling/settled delivery lifecycle is not an Apply settlement batch.
Reconciliation consumes exactly the dirty signals in its cut, under sorted
aggregate locks. Sequence allocation is not commit order. Delivery follows
commit, through the trail dispatcher's outbox.

Trail detail authorization precedes manuscript-bearing materialization. Denied
occurrences disappear; authorized deleted anchors keep their evidence. Durable
identity is a canonical live block identity, not equal text, a display hash or
an ambiguous relocation chain.

Journal and receipt signal triggers still run inside an append's draft row
hold. `change_trail_owners` retains JIT off and primary-key journal lookups;
migration 0076 removes push-journal, placement and settlement ownership reads.
Apply explicitly signals all selected member owners. A tree entry (a create, move,
delete, restore or settlement) has no parts: migration 0085 makes `change_trail_owners` follow
`tree_change.targets` and `tree_change.settles`, and the receipt trigger fire for it, so a card
Undo of a move dirties the turn that made it. The merged 0075–0081
migration series preserves historical Apply evidence, completes conversion
before its barriers, and drops the retired settlement tables.
