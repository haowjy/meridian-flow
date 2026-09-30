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
`apiThreadTurnRetryPath(threadId, turnId)` builds the canonical route path. A
new retry returns **201** with the serialized new `Turn`. Repeating the same
request ID returns **200** with that existing turn.

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
ID. Repeating the same ID after that reply exists returns it with **200** only
when it follows the requested failed turn directly or through that compaction.
While the compaction is still running, a repeated request gets the ordinary
**409** busy refusal; a new retry returns **201**.

A reply interrupted by process shutdown ends as an error with reason
`shutdown` and copy “This response failed.” Its adopted messages are
acknowledged like any failed reply, so the latest interrupted reply can be
retried after restart.

This operation is distinct from [handoff brief Retry](thread-handoff.md),
which creates a new destination seed rather than repeating a failed reply.
