# Collab — WebSocket concurrency boundary

## LOCK-WS boundary

`withDocument()` serializes coordinator callers, not writer WebSocket updates:
Hocuspocus can mutate the same in-memory Y.Doc while a coordinator callback is
awaiting journal or detection work. Any content apply after an `await` must use
durable authority and a synchronous recheck. Writer admission is journal-first;
optional sweep detection may degrade to no elevation, but it never supplies
apply authority.

The response phase-C path enforces this in
`@meridian/agent-edit`'s `applyCommittedUpdateWithRecheck`. Branch push also
enforces the invariant while holding sorted branch locks followed by sorted live
document locks. Reversal `executePrepared` snapshots around the durable write,
then delegates its final recheck and apply to `applyCommittedUpdateWithRecheck`.
Do not treat the coordinator mutex as coverage for WebSocket mutations.

Push settlement splits recheck from apply on purpose: the recheck runs inside
the batch's completion transaction, under every document mutation lock, and
the apply runs only after commit, so a rolled-back batch never reaches a warm
room. A writer admission that starts after the recheck waits on those locks and
journals after the push; Yjs merges the two in either order to the durable
state.

- **Push LOCK-WS cut**: the first instruction in each live-document lock captures
  the complete Yjs update. The push transaction stores that immutable cut and its
  durable post-cut delta; warm execution reloads the row and uses the same
  final-pre-push materializer as cold recovery. Rechecks compare complete updates,
  never state vectors, so delete-only divergence is visible.

## Live writer-admission close

Live writer-admission failure closes with `1013 writer-journal-admission-failed`
(retryable). Drive the close through the raw crossws peer
(`closeTransport` → `wsPeer.close`). Do not rely on throwing
`permissionDenied`: Hocuspocus swallows a thrown error's `.code`, so only the
direct peer close preserves the declared code and reason.
