# Failed reply Retry API

`POST /api/threads/:threadId/turns/:turnId/retry` starts an ordinary run with no
new input. Writer messages already answered by the failed reply remain user
turns in the transcript. Retry appends a new assistant reply; the failed turn
remains in history.

The request body is strict and the ID is minted by the client:

```json
{ "id": "client-minted-assistant-turn-uuid" }
```

`replyRetryRequestSchema` validates the body and
`apiThreadTurnRetryPath(threadId, turnId)` builds the canonical route path. The
answer is `ReplyRetryResponse`, `{ executionId, turn }`: the execution the
client follows (it ends when a `meridian.run_state` record shows no open
execution), the record after the reservation as `runState`, and the new reply
when it can be named. A new retry returns **201**; repeating the same request ID returns
**200** with the same execution.

Retry is available only when `turnId` is the latest assistant turn with status
`error` on the same primary or subagent thread, and no run is live. The server
checks eligibility before claiming the thread, so a refusal holds no claim.
Pending inbox rows do not block Retry; the normal run start adopts eligible
non-control rows. Otherwise the route returns **409** with
`reply_retry_unavailable`. The route also requires ownership of the thread.

Model context uses the ordinary history projection, including the failed turn.
For an early provider failure with no output, Retry's request is equivalent to
the original. After partial output or work, that activity remains honest
history. If preparation must compact first, the compaction uses a fresh turn ID
and the retried reply uses the client ID, so the optimistic reply reconciles by
ID. The first turn the request reserves records `metadata.retryReplyId`.

A replay is answered from durable facts, never from the reads that decide
eligibility: the reply by ID, else the turn this request ID reserved first (a
compaction before the reply exists, answered with `turn: null`). Before a
definitive 409 the server checks again for this request's reservation, so a
replay that raced its own Retry is answered, while another tab's Retry of the
same reply is refused. While a claim is held and nothing it could match is
reserved yet, the route returns **503** `retry_pending` with `Retry-After: 1`:
repeat the same ID. The new execution runs once prepared, even if a read that
only describes the answer fails; that answer then carries `turn: null`.

A reply interrupted by process shutdown ends as an error with reason
`shutdown` and copy “This response failed.” Its adopted messages are
acknowledged like any failed reply, so the latest interrupted reply can be
retried after restart.

This operation is distinct from [handoff brief Retry](thread-handoff.md),
which creates a new destination seed rather than repeating a failed reply.
