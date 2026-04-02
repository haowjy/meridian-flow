# Yjs Multiplexing

A single doc WS connection supports up to 10 concurrent document subscriptions. Each gets its own subId, epoch, and binary frame routing. This replaces the old per-document WS endpoint with multiplexed subscriptions on one connection.

## How to Reproduce

```bash
# Subscribe to multiple documents on one connection
# The toy client supports one -subscribe flag, so use curl/wscat or modify the client
# For basic verification, subscribe to one doc, then connect a second client to another:

# Terminal 1: Subscribe to doc A
./ws-client -token $ACCESS_TOKEN \
  -subscribe document:$DOC_A \
  -binary \
  ws://localhost:$PORT/ws/projects/$PID/docs

# Terminal 2: Subscribe to doc B on the same project
./ws-client -token $ACCESS_TOKEN \
  -subscribe document:$DOC_B \
  -binary \
  ws://localhost:$PORT/ws/projects/$PID/docs
```

**To test multiplexing on one connection** (requires a programmatic client or `wscat` with manual JSON):

```bash
# After auth + connected:
# Send subscribe for doc A
{"kind":"control","op":"subscribe","resource":{"type":"document","id":"$DOC_A"},"subId":"s-1"}
# Send subscribe for doc B
{"kind":"control","op":"subscribe","resource":{"type":"document","id":"$DOC_B"},"subId":"s-2"}

# Expect:
# subscribed for s-1 (with epoch)
# binary frame for s-1 (sync-step-1 for doc A)
# subscribed for s-2 (with epoch)
# binary frame for s-2 (sync-step-1 for doc B)
```

## Expected Behavior

1. Each subscribe gets its own `subId`, `epoch`, and per-subscription send queue
2. Binary frames routed by subId prefix — doc A frames have `s-1\x00...`, doc B frames have `s-2\x00...`
3. Framework enforces max 10 subscriptions per connection (`maxSubscriptionsPerConn = 10`)
4. Duplicate subscribe for the same document → old subscription ended first (`EndSub(oldSubId)`)
5. Each subscription has an independent Yjs session reference (reference-counted — if both subscribe to the same doc, they share the underlying Yjs state)
6. Unsubscribe one document doesn't affect others
7. Disconnect cleans up all subscriptions (framework calls `EndSub` for each, triggers `OnUnsubscribe` → session release)

## What Failure Looks Like

- **11th subscribe rejected**: Expected — framework returns `SUBSCRIBE_FAILED` error for exceeding the 10-subscription limit.
- **Binary frames delivered to wrong subscription**: SubId prefix extraction bug in the framework. Each binary frame must route to exactly one subscription.
- **Unsubscribe one doc kills the other**: Per-connection state maps (`subsByDoc`, `subsBySubId`) corrupted. Check `OnUnsubscribe` only removes the targeted subscription.
- **Session reference leak on disconnect**: `OnDisconnect` is a no-op because the framework calls `EndSub` for all active subscriptions first, which triggers `OnUnsubscribe` for each. If `EndSub` isn't called for all subs, sessions leak.
- **Cross-connection fanout hits wrong document**: `broadcastToDocSubscribers` keyed by `documentID`. If the key is wrong (e.g., using subId instead of documentID), edits fan out to the wrong document's subscribers.

## Related Code

- `backend/internal/handler/doc_ws_handler.go` — `docHandlerState.subsByDoc`, `subsBySubId`, dedup logic
- `backend/internal/wsutil/ws.go` — `maxSubscriptionsPerConn`, subscription tracking, `EndSub` on disconnect
- `backend/internal/wsutil/protocol.go` — binary frame subId extraction
