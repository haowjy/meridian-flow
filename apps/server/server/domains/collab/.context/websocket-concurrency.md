# Collab — WebSocket concurrency boundary

This page defines the LOCK-WS rule: coordinator serialization does not exclude
writer WebSocket mutations. Any content apply after an `await` must recheck
durable authority synchronously before applying or broadcasting.

`withDocument()` serializes coordinator callers only. Writer admission is
journal-first; optional sweep detection may degrade to no elevation but never
supplies apply authority. Agent-edit's
`applyCommittedUpdateWithRecheck`, branch push, and live `revert` all use
this final recheck. Keep sorted branch locks ahead of sorted live-document
locks, and do not treat the coordinator mutex as coverage for socket writes.

Push settlement rechecks inside its completion transaction under document locks
and applies to warm rooms only after commit. A writer admitted after the
recheck waits on those locks and journals after the push. The merge order may
vary, but durable Yjs state converges and rollback never reaches a warm room.

The push LOCK-WS cut captures the complete Yjs update at the first instruction
inside each live-document lock. Rechecks compare complete updates, including
delete-only divergence; state vectors alone are insufficient.

A refused branch (draft room) frame ends the room instead of reconnecting: a
closed text branch closes with `4206 branch-closed`; a refusal that repeats on
every retry (reserved client id or namespace, a stale update) closes with
`4410 write-refused`, terminal on the client; a failure that is not a verdict
closes with `1013 branch-update-admission-failed` and may reconnect. Frames the
branch already contains are acknowledged with no admission, so a clean
reconnect after a rebase raises no refusal.

A failed live writer admission closes the raw CrossWS peer with retryable code
`1013 writer-journal-admission-failed`. Do not rely on a thrown Hocuspocus
error to preserve that transport code.
