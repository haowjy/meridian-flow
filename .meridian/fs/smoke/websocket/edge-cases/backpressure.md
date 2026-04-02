# Backpressure

When a client stops reading (frozen tab, network stall), per-subscription send queues fill up. At the 200-event capacity cap, the subscription enters "gapped" state: all queued events are discarded, a `gap` message is sent, and the subscription is terminated. The connection stays alive for other subscriptions.

This is intentionally terminal per-subscription. Partial delivery after a gap creates confused client state.

## How to Reproduce

```bash
# Freeze after 5 events (simulates a frozen client)
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -freeze-after 5 \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Prerequisites**: A turn that will produce many events (long streaming response).

**Expected output**:
```
-> sent auth
<- control:connected
-> subscribe turn:$TURN_ID (subId=smoke-...)
<- control:subscribed ...
<- event seq=1 ...
<- event seq=2 ...
<- event seq=3 ...
<- event seq=4 ...
<- event seq=5 ...
!! frozen after 5 events (backpressure test) — sleeping forever
```

On the server side, the per-subscription queue fills to 200, then:
1. All queued events discarded
2. `gap` message sent
3. `EndSub(subId)` called → `OnUnsubscribe` cleanup
4. Connection stays alive

The client won't see the `gap` message because it's frozen — but the server-side behavior is the test target.

## Expected Behavior

1. Client stops reading after N events
2. `SendToSub` continues queuing events in the per-subscription buffer
3. At capacity (200 events), buffer overflows
4. Framework discards all queued events for that subscription
5. Framework sends `{"kind":"stream","op":"gap","subId":"...","payload":{"cause":"buffer_full"}}` via control queue
6. Framework calls `EndSub(subId)` — triggers `OnUnsubscribe`, frees subscription slot
7. Other subscriptions on the same connection continue unaffected
8. Notify lane continues unaffected (separate queue)

### Queue capacities
| Queue | Capacity |
|---|---|
| Per-subscription (stream events) | 200 |
| Control | 64 |
| Notify | 64 |

## What Failure Looks Like

- **Server OOM or unbounded queue growth**: Per-subscription queue capacity not enforced. `subscriptionQueueCapacity = 200` should cap it.
- **Entire connection drops on backpressure**: Framework is closing the connection instead of just the subscription. Only the overflowed subscription should terminate.
- **No `gap` sent**: Backpressure detection not wired. The queue overflow path should send gap before calling `EndSub`.
- **Other subscriptions also terminated**: `EndSub` scope leak — should only affect the overflowed subId.
- **mstream client not cleaned up**: `OnUnsubscribe` must cancel the live feed goroutine and call `stream.RemoveClient(subId)`.

## Related Code

- `backend/internal/wsutil/ws.go` — `subscriptionQueueCapacity = 200`, `SendToSub()`, backpressure detection, `EndSub()`
- `backend/internal/handler/thread_ws_handler.go` — `OnUnsubscribe()`, `detachFeed()`
