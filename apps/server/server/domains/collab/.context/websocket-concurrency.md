# Collab — WebSocket concurrency boundary

This page defines the LOCK-WS rule: coordinator serialization does not exclude
writer WebSocket mutations. Any content apply after an `await` must recheck
durable authority synchronously before applying or broadcasting.

`withDocument()` serializes coordinator callers only. Writer admission is
journal-first; optional sweep detection may degrade to no elevation but never
supplies apply authority. Agent-edit's
`applyCommittedUpdateWithRecheck` and reversal execution all use
this final recheck. Take sorted live-document locks before any transaction (the
lock order in [CONTEXT.md](CONTEXT.md)), and do not treat the coordinator mutex
as coverage for socket writes.

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
, and is acknowledged (#946: a second tab relaying a
peer's keystroke on its own socket). "Stored" includes what Yjs holds pending:
an update whose predecessor has not arrived, and a delete of a clock not yet
seen, which its state vector and snapshot leave out. The
pre-lock check against the room is only a fast refusal for reconnect replays;
the room lags admissions still in their transaction.

A removed document answers `4208 document-deleted` (terminal) wherever the
gateway refuses. Every refusing room hook (`onConnect`, `beforeSync`,
`onLoadDocument`, `connected`) runs inside `withRemovalRefusal`, the one place that decides
it, with authorization: the refusal's cause is a `DocumentNotFoundError` with a
`removal` record (raised
only past admission, under the document's mutation lock, so nothing was
journaled), or the room's document has a removal record (`roomRemoval`: a draft
room's by its retained draft, never reopened) and the principal may read the
document's history (`historyAccess` answers `deleted`). Otherwise the refusal
keeps its own close (`4409` for access, `1013`, `1008`, the draft prefix
close); an account that can't read the document learns nothing of its
removal. Inner code throws a `RoomRefusal` carrying its close and never sends
one itself, so `4208` is never preceded by another code. The lookup runs only
on refusal paths.

A failed live writer admission closes the raw CrossWS peer with retryable code
`1013 writer-journal-admission-failed`. Do not rely on a thrown Hocuspocus
error to preserve that transport code.

## Stable draft close protocol

Draft rooms are `draft:<draftId>` from seed to close. Ordinary terminal retirement
(Discard all or Work purge) sends `4205` (`DRAFT_CLOSED`), with reason `discarded`,
only after root commit. A pending room load is included. Transport close precedes
Hocuspocus protocol close so the provider receives the numeric code. Removal wins
over Discard in the same transaction and keeps `4208` for live and draft rooms.
`4206` is retired. `4207 draft-prefix-missing` remains a reconnect: the next
SyncStep2 supplies the missing prefix. Work access refusals never become draft
closes. Live authority generations and restore fencing are unchanged.
