# Streaming Lifecycle

The core happy path: connect, authenticate, subscribe to a turn, receive streaming events, and observe the `ended` signal.

This validates the full control→stream lane pipeline — auth bootstrap, subscription with atomic catchup, live event delivery via mstream, and clean termination with `EndSub` freeing the subscription slot.

## How to Reproduce

**Prerequisites**: A project with an active (streaming) turn, or trigger one via the API.

```bash
# 1. Start a turn via REST
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Write a short paragraph about cats"}'
# Note the assistant turn ID from the response

# 2. Connect and subscribe
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output**:
```
-> sent auth
<- control:connected
-> subscribe turn:$TURN_ID (subId=smoke-...)
<- control:subscribed subId=smoke-... {"headSeq":0,"recovered":false,"catchupCount":0}
<- event seq=1 {"type":"LIFECYCLE","lifecycle":"RUN_STARTED"...}
<- event seq=2 {"type":"TEXT_DELTA","text":"..."...}
<- event seq=3 {"type":"TEXT_DELTA","text":"..."...}
...
<- ENDED reason="completed"
```

**Key observations**:
- `connected` arrives after auth (with `connectionId`)
- `subscribed` confirms the subscription with `epoch`, `headSeq`, `recovered`, `catchupCount`
- Events have monotonically increasing `seq` within the subscription
- `ended` is the terminal signal — no more events after this
- The client does NOT need to send `unsubscribe` after `ended` (framework calls `EndSub` automatically)

## Expected Behavior

1. Auth frame sent → `connected` response within 5s
2. Subscribe → `subscribed` with `epoch` (random UUID) and `headSeq`
3. Stream events arrive with `kind: "stream"`, `op: "event"`, monotonic `seq`
4. Payloads are AG-UI events (`TEXT_DELTA`, `LIFECYCLE`, etc.)
5. Stream terminates with `ended` and `reason: "completed"` (or `"error"`, `"cancelled"`)
6. `ended.payload.finalSeq` matches the last event's seq

## What Failure Looks Like

- **No `connected` response**: Auth bootstrap failed — check JWT validity and project membership. Look for `auth_failed` error frame.
- **Subscribe returns error**: `SUBSCRIBE_FAILED` — turn doesn't exist or user lacks access. Error is intentionally generic (no turn-existence oracle).
- **Events stop mid-stream with no `ended`**: Connection died silently. Check server logs for write failures or panics.
- **`seq` gaps in events**: Backpressure triggered — subscription was terminated with a `gap`. See [backpressure](../edge-cases/backpressure.md).
- **`ended` with wrong reason**: `resolveEndedReason` reads turn status from DB. If DB is stale, reason may not match actual completion state.

## Related Code

- `backend/internal/wsutil/ws.go` — `Serve()`, auth bootstrap, read loop, write loop
- `backend/internal/wsutil/auth.go` — `BootstrapAuth()`, 5s timeout
- `backend/internal/handler/thread_ws_handler.go` — `OnSubscribe()`, `subscribeWithStream()`, `runLiveFeed()`
- `meridian-stream-go/stream.go` — `SubscribeWithCatchup()`, live channel delivery
