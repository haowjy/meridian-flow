# Panic Recovery

Handler panics are recovered by the framework. A panic in `OnSubscribe`, `OnMessage`, or a live-feed goroutine does not kill the connection. Other subscriptions and the heartbeat continue running.

The live-feed goroutine has its own `recover()` wrapper that logs the stack trace, calls `EndSub`, and removes the mstream client.

## How to Reproduce

This requires injecting a panic in handler code. The most practical approach is an integration test or a debug build with a panic trigger.

```bash
# No direct toy-client reproduction — panics are internal to the handler.
# Verify via the integration test suite:
cd backend
go test ./internal/handler/ -run TestPanicRecovery -v

# Or verify indirectly: if a subscribe fails with a server-side panic,
# the connection should stay alive for subsequent operations.
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$INVALID_TURN_ID \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads
# After the error, the connection should still respond to pings
```

## Expected Behavior

### Handler call panics (OnSubscribe, OnMessage, OnUnsubscribe)
1. Framework wraps each handler call in `recover()`
2. Panic caught → logged with stack trace
3. Error frame sent to client for that operation
4. Connection stays alive — heartbeat continues, other subscriptions unaffected
5. If `OnUnsubscribe` panics during disconnect cleanup, framework continues to next subscription

### Live-feed goroutine panics
1. Goroutine has its own `defer recover()` in `runLiveFeed()`
2. Panic caught → logged with `"thread ws live feed panic"` message and stack
3. `detachFeed(state, subID)` called — removes from per-connection state
4. `session.EndSub(subID)` called — frees subscription slot, triggers cleanup
5. Other live feeds on the same connection continue
6. Connection stays alive

## What Failure Looks Like

- **Connection drops on handler panic**: `recover()` not wrapping the handler call. The panic propagates up the goroutine stack and kills the connection's read loop.
- **Subscription leaks after live-feed panic**: `EndSub` not called in the recover block. The subscription slot is consumed but the feed is dead.
- **mstream client leaks**: `stream.RemoveClient(subId)` not called after panic. The mstream holds a reference to a dead channel, potentially blocking internal operations.
- **No log output for panics**: `recover()` swallows the panic without logging. The stack trace is critical for debugging — panics should log at Error level with `debug.Stack()`.
- **Other subscriptions affected**: Panic in one handler call corrupts shared per-connection state (e.g., `turnStreamState.mu` held during panic). The mutex must be released before the panic can propagate.

## Related Code

- `backend/internal/wsutil/ws.go` — handler call wrappers with `recover()`
- `backend/internal/handler/thread_ws_handler.go` — `runLiveFeed()` defer/recover block
- `backend/internal/handler/smoke_ws_test.go` — panic recovery integration tests
