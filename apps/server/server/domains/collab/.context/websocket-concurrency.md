# Collab — WebSocket concurrency boundary

This page defines the LOCK-WS rule: coordinator serialization does not exclude
writer WebSocket mutations. Any content apply after an `await` must recheck
durable authority synchronously before applying or broadcasting.

`withDocument()` serializes coordinator callers only. Writer admission is
journal-first; optional sweep detection may degrade to no elevation but never
supplies apply authority. Draft push and reversal execution use this final
recheck. Take sorted live-document locks before any transaction (the lock
order in [CONTEXT.md](CONTEXT.md)), and do not treat the coordinator mutex as
coverage for socket writes.

**Nothing reaches the open room inside a transaction.** A rolled-back row can't
be subtracted from a Yjs room, and a room holding one contaminates every later
read that merges it (a model read, a save's plan) with structs the journal
never stored. Two enforcement points:

- **The door.** `withDocument()` called inside a transaction hands `fn` a
  private copy (the room, the committed journal and the transaction's own rows)
  and never touches the room; it schedules `deliver` for after the root commit.
  A read-back inside the transaction (Markdown `identityPreservingSet`) reads
  that copy: its own transaction-local state.
- **A door taken before the transaction** (a held live create, push
  settlement, a live inverse) holds the room itself and its mutex through the
  commit. Its room changes wait for the root commit (`deferUntilCommit`) and
  apply to the held room directly: `deliver` would wait on the mutex the holder
  keeps while the commit awaits its callbacks. `replaceLiveDocumentMarkdown`
  defers its apply this way for every transactional caller.

**An agent-edit save** applies nothing to a live room. Its `persist` appends the
kept entries to the journal under the document's advisory lock (taken by the
reply's save, else by the append) and resolves the cut that append followed:
the journal below the batch's first row, which the lock makes exactly the rows
before it, merged with the prepared copy. A writer frame that landed between
preparing and appending is in that cut, so the receipt names what the rows
swept of it. A frame that races the append waits on the lock and journals
after.

**Delivery** of committed rows to the open room is `deliver`, an owned
obligation: one chain per document coalesces requests made while it runs, a
failed pass is retried after 250 ms, 1 s and 4 s, and one more failure retires
the room (handle retired, connections closed, dropped from Hocuspocus) so its
clients reconnect and cold-load the journal. A room left behind would take a
writer's keystrokes into text the journal already deleted, and Hocuspocus
reuses a warm room for every new connection without reloading it. Each failure
is logged once, as what it led to (`collab.room_delivery`
`delivery.retrying` / `delivery.room_retired`). `deliver` resolves after its
first attempt and never rejects; `recover` is the single attempt it runs.

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

A failed live writer admission closes the raw CrossWS peer with retryable code
`1013 writer-journal-admission-failed`. Do not rely on a thrown Hocuspocus
error to preserve that transport code.
