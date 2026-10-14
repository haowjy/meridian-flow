# Chat Stop API

`POST /api/threads/:threadId/stop` stops a chat, decided once on the server
under the thread lock. It cancels the running reply the writer saw, and hands
back every waiting writer message that no reply has taken on. The handed-back
content goes to the pressing tab's composer.

The body is strict (`stopRequestSchema`) and the request id is minted by the
client:

```json
{
  "requestId": "client-minted-uuid",
  "seenThrough": 12,
  "seenExecutionId": "execution-id-or-null",
  "mine": ["user-turn-id-this-device-sent"]
}
```

`seenThrough` is `sentThrough` from the run-state record the writer saw, and
`seenExecutionId` is that record's open execution. `mine` lists this device's
admitted messages the record may not show yet. The package's
`stopRequest(view, requestId)` builds the body from the held view.

## What one press decides

The press covers P: writer messages at or below `seenThrough`, plus `mine`.
Later messages are L.

- **The execution** is cancelled when the writer saw it, or it took on a
  message in P, unless it has taken on a message in L. Cancelling would
  answer that later message with a cancelled reply.
- **Each message in P** is exactly one of:
  - **handed back:** waiting and taken on by nothing, or held by a compaction
    this press cancels;
  - **answered:** taken on by a reply that goes on, so it stays and is answered;
  - **gone:** another request already handed it back. Every handed-back message
    at or below `seenThrough` is listed, however old, so treat `gone` as
    idempotent.

A message is never both handed back and answered. A handed-back message leaves
every conversation read (the snapshot, the model's context, compaction,
summaries and paging) and the stream removes it with
`meridian.messages.handed_back`. Its inbox row, turn and blocks stay in the
database for diagnostics.

## The answer

`StopResponse`: `handedBack` (each message's user turn id and its
`UserMessageBlock`s, in send order), `answered`, `gone`,
`cancelledExecutionId` (or null) and `runState`, the record after the press.

The decision is stored by request id. Repeating the same id and body answers
the stored decision, with the handed-back content read from the stored turns
and a fresh `runState`; it never decides again, so a lost answer is safe to
re-post. The same id with a different body is **409** `hand_back_conflict`. An
invalid body is **400** `invalid_stop`. The route requires ownership of the
thread.

Probe steps for every outcome are in
[the Stop and hand-back recipe](../qa/stop-and-hand-back.md).
