# Collab — WebSocket concurrency boundary

`withDocument()` serializes coordinator callers only. It does not exclude writer
WebSocket mutations, and writer admission is journal-first. Any content apply after
an `await` rechecks durable authority synchronously before applying or broadcasting.
Concurrent-change reporting may degrade without affecting apply authority.

A live-room writer frame is judged new under the document mutation lock, in
`LiveWriterJournal.appendWriterUpdate`. The pre-lock check against the room is only a
fast refusal for reconnect replays: the room lags admissions still in their
transaction.
