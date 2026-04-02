# Reconnect Stale Epoch

After a server restart, all in-memory epochs are gone. A client reconnecting with a pre-restart epoch receives a `gap` (cause: `epoch_mismatch` or `server_restart`). The client falls back to REST to reconstruct state.

Epochs are ephemeral by design — random UUIDs, not persisted. Server restart = new epochs. No false-positive replay is possible.

## How to Reproduce

```bash
# 1. Subscribe and note the epoch
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
# Note the epoch from the subscribed message, e.g., "abc-123"
# Ctrl+C

# 2. Restart the server
./scripts/restart-server.sh

# 3. Reconnect with the old epoch
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -last-seq 25 \
  -epoch abc-123 \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output**:
```
-> sent auth
<- control:connected
-> subscribe turn:$TURN_ID (subId=smoke-...)
<- GAP {"fromSeq":25,"toSeq":0,"cause":"server_restart"}
```

The subscription is terminated after the gap. The client must fall back to REST.

## Expected Behavior

1. Client sends subscribe with old `epoch` and `lastSeq`
2. `stream.SubscribeWithCatchup()` finds no stream (registry empty after restart)
3. Handler checks turn status via DB:
   - If `streaming` but no stream in registry → `gap{cause: "server_restart"}`
   - If terminal (`complete`/`error`/`cancelled`) → `subscribed` + `ended` (no replay needed)
   - If `pending` → `subscribed` (client waits for notify)
4. After gap: client calls `GET /api/turns/{turnId}/blocks` for persisted state
5. If REST says turn is still streaming, client may re-subscribe with no epoch/lastSeq (fresh catchup from current buffer if stream exists now)

### REST fallback
```bash
curl http://localhost:$PORT/api/turns/$TURN_ID/blocks \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# Returns persisted blocks + turn status
# Client reconstructs state from blocks (same as initial page load)
```

## What Failure Looks Like

- **Stale events replayed (false-positive)**: Epoch comparison is broken — the server is matching an old epoch to a new stream. Epochs must be string-equality compared, never ordered.
- **No `gap` sent — subscribe hangs**: Handler not checking for "stream in DB but not in registry" case. The `subscribeWithoutStream` path should send gap for `streaming` status.
- **`gap` but client can't reach REST**: REST fallback is the recovery path. If REST is also down, client is stuck. Not a WS bug — both systems must be available.
- **Client enters gap→subscribe→gap loop**: See [two-gap-livelock](two-gap-livelock.md). Client should stop after two consecutive gaps.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — `subscribeWithoutStream()`, status-based gap/ended logic
- `meridian-stream-go/stream.go` — `SubscribeWithCatchup()`, `ErrEpochMismatch`
- `meridian-stream-go/registry.go` — `Registry.Get()` returns nil after restart
