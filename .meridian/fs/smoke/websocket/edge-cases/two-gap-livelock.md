# Two-Gap Livelock

A client that receives a gap, re-subscribes, and receives another gap must stop retrying. Without this rule, a server that lost an in-memory stream (restart, crash) creates an infinite loop: gap → subscribe (no epoch) → gap → subscribe → gap...

The "two gaps = stop" rule is enforced client-side, per turnId. After two consecutive gaps for the same turn, the client treats it as terminal and renders persisted blocks from REST.

## How to Reproduce

```bash
# 1. Start a turn and let it begin streaming
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Long task..."}'

# 2. Restart the server while the turn is streaming
./scripts/restart-server.sh

# 3. Subscribe — will get a gap (no stream in registry, DB says streaming)
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
# Output: <- GAP {"cause":"server_restart"}

# 4. Subscribe again (simulating client retry) — same gap
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
# Output: <- GAP {"cause":"server_restart"}

# Client should NOT retry a third time
```

## Expected Behavior

1. First gap: client calls `GET /api/turns/{turnId}/blocks`
2. REST says `status: streaming` — turn is still running (in the DB's view)
3. Client sends fresh subscribe (no `lastSeq`/`epoch`) hoping the server has re-registered the stream
4. Second gap: server still doesn't have the stream in memory
5. **Client stops**: Treats the turn as terminal. Renders persisted blocks. Waits for a `completed`/`error` notify event to learn when the turn actually finishes.
6. When the turn eventually completes (or errors), the server emits a notify event that triggers cache invalidation

### Client-side tracking
- Track gap count per `turnId` (not per subId — subIds change on re-subscribe)
- Reset gap count when a `subscribed{recovered: true}` or any `event` arrives
- Two consecutive gaps for the same turnId → stop

## What Failure Looks Like

- **Infinite gap loop**: Client has no gap-count tracking. It re-subscribes forever, wasting server resources and never rendering anything.
- **Gap count tracked per subId instead of turnId**: SubId changes on each subscribe. Client loses the gap count and retries indefinitely.
- **Client never recovers after server rebuilds stream**: Gap count not reset on successful subscribe. The turn actually becomes available again, but the client refuses to subscribe because it remembered the old gaps.
- **No notify event after turn completes**: Client is stuck showing stale persisted blocks forever. The notify path must emit `completed`/`error` for the turn.

## Related Code

- Protocol spec: `protocol.md` § Gap Recovery
- `backend/internal/handler/thread_ws_handler.go` — `subscribeWithoutStream()` gap for `streaming` status
- Client-side gap tracking is a frontend concern — not in the backend code
