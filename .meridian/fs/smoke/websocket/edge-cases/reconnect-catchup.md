# Reconnect Catchup

When a client disconnects and reconnects mid-stream, it sends `subscribe` with `lastSeq` and `epoch` from the last received event. The server atomically snapshots the mstream buffer and registers a live channel — replaying missed events as catchup before resuming live delivery.

This validates the `SubscribeWithCatchup` atomicity guarantee: no gap between catchup and live events.

## How to Reproduce

```bash
# 1. Start a long-running turn
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Write a very detailed analysis..."}'

# 2. Subscribe and note the last seq + epoch from output
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
# Let it receive some events, note the last seq (e.g., 25) and epoch
# Ctrl+C to disconnect

# 3. Reconnect with lastSeq and epoch
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -last-seq 25 \
  -epoch $EPOCH \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output on reconnect**:
```
-> sent auth
<- control:connected
-> subscribe turn:$TURN_ID (subId=smoke-...)
<- control:subscribed subId=smoke-... {"headSeq":50,"recovered":true,"catchupCount":25}
<- event seq=26 ...  (catchup)
<- event seq=27 ...  (catchup)
...
<- event seq=50 ...  (catchup)
<- event seq=51 ...  (live — seamless transition)
```

**Key fields in `subscribed`**:
- `recovered: true` — server found the epoch and replayed from lastSeq
- `catchupCount: 25` — number of events replayed from buffer
- `headSeq: 50` — current head of the buffer at subscribe time

## Expected Behavior

1. Client sends subscribe with `lastSeq` and `epoch` in payload
2. `SubscribeWithCatchup(subId, lastSeq, epoch)` does atomic: snapshot buffer → register live channel → return catchup + live chan
3. If epoch matches and events available: `subscribed{recovered: true}` + catchup events + live events
4. Catchup events have contiguous seq from lastSeq+1 to headSeq
5. Live events continue from headSeq+1 with no gap
6. The atomic snapshot guarantees no duplicates and no missed events

## What Failure Looks Like

- **`gap` instead of catchup**: Epoch mismatch or `lastSeq` too old (buffer expired). See [reconnect-stale-epoch](reconnect-stale-epoch.md).
- **Duplicate events after catchup**: `SubscribeWithCatchup` not atomic — live channel registered before buffer snapshot, so events in flight appear in both catchup and live.
- **Missing events between catchup and live**: `SubscribeWithCatchup` not atomic — buffer snapshot taken before live channel registered, so events between snapshot and registration are lost.
- **`recovered: false` with catchup events**: `recovered` flag logic inverted. Should be `true` when `lastSeq`/`epoch` were provided and replay succeeded.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — `subscribeWithStream()`, `sendSubscribed()`, `sendCatchup()`
- `meridian-stream-go/stream.go` — `SubscribeWithCatchup()` (atomic snapshot + register)
- `meridian-stream-go/buffer.go` — event buffer, `GetSince()`
