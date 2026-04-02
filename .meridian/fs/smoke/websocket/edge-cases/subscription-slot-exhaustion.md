# Subscription Slot Exhaustion

Each connection has a max of 10 concurrent subscriptions (`maxSubscriptionsPerConn`). Stream switches should not exhaust slots because `EndSub` is called after each `ended` event, freeing the slot before the client subscribes to the successor.

This test verifies that 10+ consecutive stream switches don't brick the connection.

## How to Reproduce

```bash
# 1. Connect to the thread WS
./ws-client -token $ACCESS_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 2. Trigger a sequence of turns that each end with stream_switch
#    (e.g., repeated interjections during tool boundaries)
#    Each stream_switch cycle:
#    - Subscribe to turn N
#    - Receive events + ended{stream_switch, newAssistantTurnId}
#    - Subscribe to turn N+1
#    - Repeat

# Verify with a programmatic client or manual JSON:
# After 10+ stream switches, the 11th subscribe should still succeed
# because each ended triggers EndSub which frees the slot
```

**To test the limit directly** (without stream switch):
```bash
# Subscribe to 10 different turns (use wscat or programmatic client)
# 11th subscribe should fail with SUBSCRIBE_FAILED
# Then unsubscribe one → 11th subscribe should succeed
```

## Expected Behavior

1. Stream switch: `ended` sent → `EndSub(subId)` called by framework
2. `EndSub` removes subId from tracking, decrements subscription counter, triggers `OnUnsubscribe`
3. Slot freed → client can subscribe to successor
4. After 10+ switches, subscription count is still 1 (only the current turn)

### Subscription lifecycle per switch
```
subscribe(turn-1)   → count: 1
ended(turn-1)       → EndSub → count: 0
subscribe(turn-2)   → count: 1
ended(turn-2)       → EndSub → count: 0
... (repeatable indefinitely)
```

### Hard limit test
```
subscribe(s-1) ... subscribe(s-10) → count: 10
subscribe(s-11) → SUBSCRIBE_FAILED (limit reached)
unsubscribe(s-1) → count: 9
subscribe(s-11) → count: 10 (succeeds)
```

## What Failure Looks Like

- **11th subscribe fails after stream switches**: `EndSub` not freeing the subscription slot. Counter incremented on subscribe but not decremented on `EndSub`.
- **`EndSub` called but slot not freed**: `EndSub` removes the subId from the tracking map but doesn't decrement the atomic counter. The counter drifts from reality.
- **Double-decrement on EndSub + unsubscribe**: If both the handler and the framework call `EndSub`, idempotency is critical. `EndSub` must be a no-op on second call.
- **Connection dies after many switches**: Memory leak in per-connection state — `turnSubs` or `liveFeeds` maps not cleaned up on `EndSub`/`OnUnsubscribe`.

## Related Code

- `backend/internal/wsutil/ws.go` — `maxSubscriptionsPerConn = 10`, subscription counter, `EndSub()` idempotency
- `backend/internal/handler/thread_ws_handler.go` — `OnUnsubscribe()`, `detachFeed()`, `turnSubs` cleanup
