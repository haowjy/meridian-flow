# Stream Switch Race

An interjection arriving during the drain window (between `BeginDrain` and `CompleteDrain`) must be forwarded to the successor turn, not lost. The `InterjectionRouter` handles this via epoch-guarded drain: late interjections during the window are captured and forwarded to the new turn.

## How to Reproduce

This is a timing-dependent race. The most reliable reproduction uses the interjection forwarder test harness, but the WS path can trigger it:

```bash
# 1. Start a turn that will use tools (triggers drain at tool boundary)
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Write a chapter with multiple proposals"}'

# 2. Subscribe and watch for tool calls
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 3. Rapidly send interjections during tool execution (timing-dependent)
#    Use a loop or parallel curl requests:
for i in $(seq 1 5); do
  curl -X POST http://localhost:$PORT/api/turns/$TURN_ID/interjection \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"Interjection $i\", \"mode\": \"append\"}" &
done
```

## Expected Behavior

1. Tool boundary reached → `InterjectionRouter.BeginDrain(turnID)` returns `(epoch, drainedContent, true)`
2. Drain epoch guards the window — any `Route()` call during drain is captured as "late"
3. `CompleteDrain(turnID, epoch, newTurnID)` returns late interjections
4. Late interjections forwarded to successor turn's buffer
5. `Rollback(turnID, epoch)` if the drain aborts (e.g., switch fails)
6. Client sees `ended{reason: "stream_switch"}` on the original turn
7. Successor turn starts with the interjection content applied

### Drain lifecycle
```
Route("turn-1", "change X") → queued (normal)
BeginDrain("turn-1") → epoch=42, drained="change X"
Route("turn-1", "also Y") → held (epoch active, captured as late)
CompleteDrain("turn-1", 42, "turn-2") → late="also Y"
# "also Y" forwarded to turn-2's buffer
```

## What Failure Looks Like

- **Interjection lost**: `Route()` during drain returned `held=true` but `CompleteDrain` didn't return the late content. Epoch mismatch or late buffer not read.
- **Interjection applied to wrong turn**: Late content forwarded to original turn instead of successor. `CompleteDrain`'s `newTurnID` parameter not used for forwarding.
- **Drain never completes**: `BeginDrain` called but neither `CompleteDrain` nor `Rollback` called. Buffer stuck in drain state — subsequent `Route()` calls all held indefinitely.
- **`ended` sent but successor never starts**: `SwitchStream` failed after drain. `Rollback` should restore the buffer, but if it wasn't called, the turn is in limbo.

## Related Code

- `backend/internal/service/llm/streaming/interjection_forwarder.go` — `BeginDrain()`, `CompleteDrain()`, `Rollback()`, late capture
- `backend/internal/service/llm/streaming/interjection_forwarder_test.go` — race scenario tests
- `backend/internal/service/llm/streaming/interjection_router.go` — `InterjectionRouter` interface
