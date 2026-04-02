# Interjection

Send an interjection to an active turn via the WebSocket stream lane. The server routes it through the `InterjectionRouter` and returns `queued` (buffered while streaming) or `created` (follow-up turn created because turn was idle/complete).

This validates the WS interjection path shares the same service-layer routing as the HTTP endpoint — same validation, same auth checks, same `InterjectionRouter.Route()` call.

## How to Reproduce

**Queued mode** — interjection while turn is streaming:

```bash
# 1. Start a long-running turn
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Write a very long essay about the history of computing"}'

# 2. Connect, subscribe, and interject while streaming
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -interject "Actually, focus on the 1970s" \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output (queued)**:
```
-> sent auth
<- control:connected
-> subscribe turn:$TURN_ID (subId=smoke-...)
<- control:subscribed ...
<- event seq=1 ...
-> interjection: Actually, focus on the 1970s
<- control:interjection_result ... {"mode":"queued","content":"Actually, focus on the 1970s"}
<- event seq=2 ...
...
<- ENDED reason="completed"
```

**Created mode** — interjection after turn completes (requires manual timing or a second connection):

```bash
# Wait for turn to complete, then connect and interject
# The interjection creates follow-up turns because the target turn is no longer streaming
```

**Expected output (created)**:
```
<- control:interjection_result ... {"mode":"created","newAssistantTurnId":"<uuid>"}
```

## Expected Behavior

1. Client sends `{"kind":"stream","op":"message","resource":{"type":"turn","id":"..."},"payload":{"action":"interjection","text":"...","mode":"append"}}`
2. Handler validates: UUID format, non-empty trimmed content, valid mode (`append`|`replace`), rejects unknown fields
3. Handler re-checks `CanAccessTurn` authorization
4. `InterjectionRouter.Route()` called — same path as HTTP
5. Response via control lane: `interjection_result` with `mode` and relevant fields

## What Failure Looks Like

- **Error frame `INVALID_MESSAGE`**: Payload validation failed — bad action, empty text, unknown fields. The WS handler uses the same `parseWSInterjectionPayload` → `normalizeUpsertInterjectionRequest` chain as HTTP.
- **Error frame with no detail**: Auth check failed for the turn. Errors are intentionally generic.
- **No response at all**: Handler panicked during interjection routing. Check server logs. Connection should still be alive (panic recovery).
- **`queued` when expecting `created` (or vice versa)**: Turn status changed between the interjection send and the route call. Race condition — not a bug.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — `OnMessage()`, `parseWSInterjectionPayload()`
- `backend/internal/handler/interjection_validation.go` — shared validation with HTTP
- `backend/internal/service/llm/streaming/interjection_router.go` — `InterjectionRouter` interface
- `backend/internal/service/llm/streaming/interjection.go` — interjection buffer
