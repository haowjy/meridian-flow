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
reply's save, else by the append), and `appendBatch` returns, from inside that
operation, the document as it found it under the lock; the save's cut is that
state merged with the prepared copy. A writer frame that landed between
preparing and appending is in that cut, so the receipt names what the rows
swept of it, and a save's precondition (a create only into an empty document)
is judged on it before anything is written. A frame that races the append waits
on the lock and journals after. No storage read runs between the append
committing and the save learning it did.

**Delivery** of committed rows to the open room is `deliver`, an owned
obligation that only retries: one chain per document coalesces requests made
while it runs. A failed pass starts an outage against the room that is behind,
retried after 250 ms, 1 s, 4 s and then every 30 s for as long as Hocuspocus
holds that same room. It ends with a pass that catches the room up, or when
Hocuspocus unloads or replaces the room (a load reads the journal); a retry
never delivers into a replacement. Room lifetime is Hocuspocus's alone:
delivery never closes connections, removes a room from the registry or retires
a handle. A delivery that keeps failing means the journal can't be read, and a
writer's frames are journal-first, so they fail too. A request made during a
retry's wait or its failing attempt (a save, a transactional door's commit)
runs its pass at once into whatever room is open, so a save never waits on a stalled
delivery. Without one, a room stays behind the journal after the database
recovers until the next retry, up to 30 s; the writer can type into it
meanwhile and catches up on that pass. An outage is logged once at each end
(`collab.room_delivery` `delivery.failing` warn, `delivery.recovered` info).
`deliver` resolves after the pass that served it and never rejects; it is the
live door's only catch-up.

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
