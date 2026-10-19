# Collab — WebSocket concurrency boundary

This page defines the LOCK-WS rule: coordinator serialization does not exclude
writer WebSocket mutations. Any content apply after an `await` must recheck
durable authority synchronously before applying or broadcasting.

`withDocument()` serializes coordinator callers only. Writer admission is
journal-first; optional sweep detection may degrade to no elevation but never
supplies apply authority. Agent-edit's
`applyCommittedUpdateWithRecheck`, draft push, and reversal execution all use
this final recheck. Take sorted live-document locks before any transaction (the
lock order in [CONTEXT.md](CONTEXT.md)), and do not treat the coordinator mutex
as coverage for socket writes.

Push settlement rechecks inside its completion transaction under document locks
and applies to warm rooms only after commit. A writer admitted after the
recheck waits on those locks and journals after the push. The merge order may
vary, but durable Yjs state converges and rollback never reaches a warm room.

The push LOCK-WS cut captures the complete Yjs update at the first instruction
inside each live-document lock. Rechecks compare complete updates, including
delete-only divergence; state vectors alone are insufficient.

Draft rooms have no coordinator serialization at all: a Work-draft writer
frame is one sequenced append, ordered by the draft row's lock and finalized
there against the committed prefix, never fenced by a revision (see the append
contract in [CONTEXT.md](CONTEXT.md#transaction-and-lock-contracts)). A frame
racing another write waits for the row lock once and never judges again; no
draft mutex exists to hold against a frame.

A live-room writer frame is judged new the same way, where it serializes:
collab's `LiveWriterJournal.appendWriterUpdate` port holds the document
mutation lock, reads the stored document and judges the update against it, then
inserts. A copy whose structs and deletes are already stored returns
`{ status: "contained" }`, as a draft append does, and writes no row, no receipt
and no settlement join, and is acknowledged (#946: a second tab relaying a
peer's keystroke on its own socket). "Stored" includes what Yjs holds pending:
an update whose predecessor has not arrived, and a delete of a clock not yet
seen, which its state vector and snapshot leave out. The
pre-lock check against the room is only a fast refusal for reconnect replays;
the room lags admissions still in their transaction.

A removed document answers `4208 document-deleted` (terminal) wherever the
gateway refuses: a failed grant at `beforeSync`, `DocumentRemovedError` from
live admission, a draft frame's refusal, and a draft room whose draft closed
because its document was removed. The lookup (`roomRemoval`) runs only on
those refusal paths; other refusals keep their codes (`4409` for access).

A failed live writer admission closes the raw CrossWS peer with retryable code
`1013 writer-journal-admission-failed`. Do not rely on a thrown Hocuspocus
error to preserve that transport code.
