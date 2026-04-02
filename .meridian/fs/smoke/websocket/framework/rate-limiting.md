# Rate Limiting

The framework enforces 30 inbound messages per second per connection. Excess messages are dropped silently after an initial `error` notification. This applies to all frame types — control, stream, and binary.

## How to Reproduce

```bash
# Flood 50 messages rapidly
./ws-client -token $ACCESS_TOKEN \
  -flood 50 \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output**:
```
-> sent auth
<- control:connected
-> flooding 50 messages
-> flood sent, reading responses...
<- ERROR error: {"code":"RATE_LIMITED","message":"..."}
```

Only one `RATE_LIMITED` error frame is sent. Subsequent excess messages within the window are dropped silently — no error frame per dropped message.

## Expected Behavior

1. Framework tracks inbound messages per second per connection
2. First 30 messages in a 1-second window: processed normally
3. Message 31+: first excess triggers `RATE_LIMITED` error frame
4. Subsequent excess in the same window: dropped silently (no additional error frames)
5. Next window: counter resets, messages flow again
6. Connection stays alive — rate limiting is not a disconnect event

### What counts toward the limit
- JSON text frames (control, stream messages)
- Binary frames (Yjs data)
- Pong responses count as inbound messages

### What doesn't count
- Server-originated messages (events, notifies) — outbound only

## What Failure Looks Like

- **No `RATE_LIMITED` error**: Rate limiter not wired. Check `WithRateLimit(30)` in server construction.
- **Connection closes on rate limit**: Framework should keep the connection alive. If it closes, the rate limit handler is calling `Close()` instead of just dropping.
- **All 50 flood messages processed**: Rate limiter not checking inbound messages in the read loop. The `defaultRateLimitPerSec = 30` constant should be applied.
- **Error frame per excess message (spam)**: Only the first excess should trigger an error. Subsequent drops should be silent to avoid amplification.

## Related Code

- `backend/internal/wsutil/ws.go` — `defaultRateLimitPerSec = 30`, rate limit counter in read loop
- `backend/internal/wsutil/protocol.go` — `RATE_LIMITED` error code
