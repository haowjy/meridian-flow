# Failed reply Retry API

`POST /api/threads/:threadId/turns/:turnId/retry` starts a new reply for the
same inbox messages adopted by a failed assistant turn. The failed turn remains
unchanged in history; Retry appends a new assistant turn after it.

The request body is strict and the ID is minted by the client:

```json
{ "id": "client-minted-assistant-turn-uuid" }
```

`replyRetryRequestSchema` validates the body and
`apiThreadTurnRetryPath(threadId, turnId)` builds the canonical route path. A
new retry returns **201** with the serialized new `Turn`. Repeating the same
request ID returns **200** with that existing turn.

Retry is available only when `turnId` is the latest failed assistant reply on
the same primary or subagent thread, the chat has no active run, and the inbox
is empty. Otherwise the route returns **409** with
`reply_retry_unavailable`. The route also requires ownership of the thread.

The retry request uses the saved adopted messages and excludes the failed
assistant turn from model history. This recreates the original request rather
than asking the model to continue from a failure marker. The failed turn still
remains visible in transcript history, immediately before the new reply.

This operation is distinct from [handoff brief Retry](thread-handoff.md),
which creates a new destination seed rather than repeating a failed reply.
