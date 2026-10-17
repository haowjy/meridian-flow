# Collab — WebSocket concurrency boundary

This page defines the LOCK-WS rule: coordinator serialization does not exclude
writer WebSocket mutations. Any content apply after an `await` must recheck
durable authority synchronously before applying or broadcasting.

`withDocument()` serializes coordinator callers only. Writer admission is
journal-first; optional sweep detection may degrade to no elevation but never
supplies apply authority. Agent-edit's
`applyCommittedUpdateWithRecheck`, branch push, and reversal execution all use
this final recheck. Keep sorted branch locks ahead of sorted live-document
locks, and do not treat the coordinator mutex as coverage for socket writes.

Push settlement rechecks inside its completion transaction under document locks
and applies to warm rooms only after commit. A writer admitted after the
recheck waits on those locks and journals after the push. The merge order may
vary, but durable Yjs state converges and rollback never reaches a warm room.

The push LOCK-WS cut captures the complete Yjs update at the first instruction
inside each live-document lock. Rechecks compare complete updates, including
delete-only divergence; state vectors alone are insufficient.

Branch rooms have no coordinator serialization at all: a Work-draft writer
frame is an optimistic append at its replica's revision (see the transaction
and lock contracts in [CONTEXT.md](CONTEXT.md)). Every other branch write moves
the revision, so a frame racing it misses and judges again; nothing holds a
lease or mutex against a frame.

A failed live writer admission closes the raw CrossWS peer with retryable code
`1013 writer-journal-admission-failed`. Do not rely on a thrown Hocuspocus
error to preserve that transport code.
