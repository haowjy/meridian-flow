# Collab — committed change trail

The staged Apply/settlement pipeline is deleted. There is no pending settlement
store, contribution replacement/refinement, seed parser, owner reopening,
worker recovery call, ingress barrier or offline-reconciliation service.
Lane A builds atomic Apply and its committed live effect; it must not replay
draft journal rows onto live to reconstruct owners. Receipt classification
supplies ownership; canonical live before/after identities supply navigation.

`DurableTrailRecord`, normalized committed changes, aggregate persistence,
authorized reads/navigation, dirty signals and the delivery outbox remain.
`draft-trail-projection.ts` retains live identity comparison/navigation and
committed record persistence, not journal-attribution reconstruction.
`document-difference.ts` remains for lane A's focused trim.

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
D1 does not change installed SQL or migrations. A/MIG own replacement signaling,
historical Apply conversion and physical settlement-table drops.
