# Spawn Discovery

When a spawn launches, the service layer emits a `spawn_started` notify event to all project connections. The frontend uses this to invalidate queries and optionally auto-subscribe to the spawn's assistant turn for streaming.

Spawn discovery is a notify-lane event — no subscription required. All connections for the project receive it automatically.

## How to Reproduce

```bash
# 1. Connect to the thread WS (no subscription needed for notify events)
./ws-client -token $ACCESS_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 2. In another terminal, trigger a task that spawns subagents
curl -X POST http://localhost:$PORT/api/projects/$PID/threads \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Research this topic in depth using multiple approaches"}'
# Wait for the turn to spawn subagents
```

**Expected output**:
```
-> sent auth
<- control:connected
...
<- notify:invalidate resource=turn:<parent-turn-id> {"event":"spawn_started","spawnThreadId":"...","spawnTurnId":"..."}
```

After seeing `spawn_started`, subscribe to the spawn's turn:
```bash
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$SPAWN_TURN_ID \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

## Expected Behavior

1. Spawn launch emits `spawn_started` notify via `Broadcaster.BroadcastNotify()`
2. Notify includes `spawnThreadId` and `spawnTurnId` in payload
3. Resource is the parent turn (`resource.type: "turn"`, `resource.id: <parent>`)
4. All project connections receive it — no subscription needed
5. Client can subscribe to `spawnTurnId` for streaming

## What Failure Looks Like

- **No `spawn_started` notify**: Service layer isn't calling `Broadcaster.BroadcastNotify()` on spawn launch. Check streaming service spawn path.
- **Notify arrives but `spawnTurnId` is empty**: Payload construction bug in the emit call.
- **Subscribe to spawn turn returns `gap` immediately**: Spawn's mstream already expired. May need buffer retention like successor turns.
- **Notify arrives on wrong connections**: `BroadcastNotify` uses the wrong `projectID`. Should scope to the project the spawn belongs to.

## Related Code

- `backend/internal/handler/thread_ws_handler.go` — notify event definitions
- `backend/internal/wsutil/ws.go` — `BroadcastNotify()` implementation
- `backend/internal/service/llm/streaming/service.go` — spawn launch notify emission
