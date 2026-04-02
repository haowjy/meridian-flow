# Stream Switch

When an interjection triggers at a tool boundary (or turn completion), the current turn's stream ends with `reason: "stream_switch"` and the payload includes `newAssistantTurnId`. A `stream_started` notify event is broadcast for the successor turn, and the client auto-subscribes.

This replaces the SSE `STREAM_SWITCH` event entirely. The `ended` message is the canonical stream-switch signal.

## How to Reproduce

```bash
# 1. Start a turn that will use tools (e.g., a writing task that triggers proposals)
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Write a new chapter for the story"}'

# 2. Connect and subscribe
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 3. While the turn is streaming (at a tool boundary), send an interjection
#    via a second client or via HTTP:
curl -X POST http://localhost:$PORT/api/turns/$TURN_ID/interjection \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Change direction completely", "mode": "append"}'
```

**Expected output on the WS client**:
```
<- event seq=N ...
<- ENDED reason="stream_switch" {"reason":"stream_switch","finalSeq":N,"newAssistantTurnId":"<successor-uuid>"}
<- notify:invalidate {"event":"stream_started"} resource=turn:<successor-uuid>
```

After receiving `ended{stream_switch}`, the client subscribes to the successor:
```bash
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$SUCCESSOR_TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

## Expected Behavior

1. Current turn's mstream closes → live feed goroutine sends `ended` with `reason: "stream_switch"` and `newAssistantTurnId`
2. `resolveEndedReason()` reads turn from DB — `stop_reason: "stream_switch"` and `response_metadata.successor_turn_id`
3. `stream_started` notify broadcast to all project connections
4. `EndSub` frees the subscription slot for the old turn
5. Client subscribes to successor — gets fresh `subscribed` + live events
6. Successor's mstream buffer is retained for up to 30s until first subscribe (prevents race where fast successor completes before client subscribes)

## What Failure Looks Like

- **`ended` with `reason: "completed"` instead of `"stream_switch"`**: `resolveEndedReason` fell through to default. Turn's `stop_reason` wasn't set to `stream_switch` in DB — check `SwitchStream` service layer.
- **`ended` with no `newAssistantTurnId`**: `successorTurnID()` couldn't find `successor_turn_id` in turn's `response_metadata`. Check that `SwitchStream` persists it.
- **Subscribe to successor returns `gap`**: Successor completed before subscribe and buffer expired. The 30s retention window was insufficient or wasn't applied. See [reconnect-catchup](../edge-cases/reconnect-catchup.md).
- **No `stream_started` notify**: Notify broadcast not wired for the successor turn. Check service layer emit.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — `runLiveFeed()`, `resolveEndedReason()`, `endedReasonFromTurn()`
- `backend/internal/service/llm/streaming/interjection_forwarder.go` — drain/switch logic
- `meridian-stream-go/stream.go` — buffer retention on completion
