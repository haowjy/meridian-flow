# Missed Stream Switch

If the client's WebSocket was disconnected during a stream switch, it misses the `ended{reason: "stream_switch"}` event. The client discovers the successor via REST — the turn's `response_metadata` contains `successor_turn_id`.

REST is the source of truth; the WS event is a fast path. This ensures the client can always follow the stream switch chain.

## How to Reproduce

```bash
# 1. Start a turn that will trigger a stream switch
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Task that will trigger tool use and stream switch"}'

# 2. Subscribe briefly, then disconnect before the switch happens
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
# Ctrl+C after receiving some events (before ended)

# 3. Wait for the stream switch to happen, then check via REST
curl http://localhost:$PORT/api/turns/$TURN_ID/blocks \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

**Expected REST response** (after stream switch):
```json
{
  "turn": {
    "id": "$TURN_ID",
    "status": "complete",
    "stop_reason": "stream_switch",
    "response_metadata": {
      "successor_turn_id": "<successor-uuid>"
    }
  },
  "blocks": [...]
}
```

```bash
# 4. Subscribe to the successor turn
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$SUCCESSOR_TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

## Expected Behavior

1. Client disconnects — misses `ended{stream_switch}` and `stream_started` notify
2. Client reconnects and calls `GET /api/turns/{turnId}/blocks`
3. REST response shows `status: complete`, `stop_reason: stream_switch`
4. `response_metadata.successor_turn_id` points to the new assistant turn
5. Client subscribes to successor — picks up the chain
6. If successor also completed with a stream switch, client follows the chain recursively

### Discovery chain
For multiple consecutive switches (turn A → B → C):
```
GET /api/turns/A/blocks → stop_reason: stream_switch, successor: B
GET /api/turns/B/blocks → stop_reason: stream_switch, successor: C
GET /api/turns/C/blocks → status: streaming → subscribe to C
```

## What Failure Looks Like

- **`successor_turn_id` missing from REST response**: `SwitchStream` didn't persist the successor ID to `response_metadata`. Check the service layer's switch path.
- **`stop_reason` not set to `stream_switch`**: Turn completed with a different stop reason. The switch path must set `stop_reason = "stream_switch"` before completing the turn.
- **Successor turn doesn't exist**: `SwitchStream` failed after completing the original turn. Orphaned turn with `stream_switch` stop reason but no successor.
- **REST returns `streaming` but subscribe returns `gap`**: Server restarted after the switch. The successor's mstream is gone. Fall back to REST for the successor too.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — `endedReasonFromTurn()`, `successorTurnID()`
- `backend/internal/service/llm/streaming/launch_stream.go` — `SwitchStream()`, successor creation
- REST blocks endpoint — turn response with `response_metadata`
