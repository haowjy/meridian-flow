# Heartbeat Auth Revocation

When a user loses project access (removed from project, JWT expired), the next heartbeat cycle detects it and tears down the entire connection. All subscriptions are terminated, live feeds cancelled, and the WS closed. The teardown happens within one heartbeat interval (20s).

## How to Reproduce

```bash
# 1. Connect and subscribe to a turn
./ws-client -token $ACCESS_TOKEN \
  -subscribe turn:$TURN_ID \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 2. While the client is connected and receiving events,
#    revoke the user's project access:
#    - Remove user from project members (admin API or direct DB)
#    - Or invalidate the JWT (depends on auth implementation)

# 3. Wait up to 20s for the next heartbeat cycle
```

**Expected output**:
```
<- event seq=N ...
<- ping -> pong    (re-auth still passes)
<- event seq=N+1 ...
<- ping -> pong    (re-auth fails this cycle)
read error: ...    (connection closed by server)
```

The connection closes within 20s of access revocation. No explicit error frame — the connection is torn down during the heartbeat cycle.

### With expired JWT
```bash
# Use a short-lived JWT (e.g., 30s expiry)
./ws-client -token $SHORT_LIVED_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# After JWT expires, next heartbeat detects it
# Connection torn down within 20s of expiry
```

## Expected Behavior

1. Heartbeat fires every 20s
2. Each cycle: check JWT expiry → check `CanAccessProject(userID, projectID)`
3. Either check fails → connection marked for teardown
4. Framework calls `EndSub(subId)` for all active subscriptions
5. `EndSub` triggers `OnUnsubscribe` → live feed goroutines cancelled, mstream clients removed
6. Framework calls `OnDisconnect` for all handlers
7. WS connection closed with appropriate close code

### Timing bounds
- **Best case**: Revocation detected on the next heartbeat (up to 20s)
- **Worst case**: Revocation detected on the heartbeat after the next ping (up to 40s if heartbeat just fired)
- **JWT expiry check**: Server-side check, not dependent on client sending pong

## What Failure Looks Like

- **Connection stays alive after revocation**: Heartbeat not re-checking `CanAccessProject`. Only checking JWT expiry is insufficient — membership can be revoked without token expiry.
- **Subscriptions leak after teardown**: `EndSub` not called for all active subscriptions before `OnDisconnect`. Must iterate all subscriptions.
- **Live feeds keep running after connection close**: `EndSub` → `OnUnsubscribe` should cancel live feed goroutines via context cancellation. If the cancel function isn't called, goroutines leak.
- **Revocation takes minutes**: Heartbeat interval misconfigured (should be 20s). Check `WithHeartbeat(20*time.Second, 20*time.Second)`.
- **Client can still subscribe after revocation detected**: Race between heartbeat teardown and client subscribe. Framework should reject subscribes on a closing connection.

## Related Code

- `backend/internal/wsutil/ws.go` — heartbeat loop, re-auth check, connection teardown
- `backend/internal/wsutil/auth.go` — `Authenticator.CheckProjectAccess()`, `ErrAuthExpired`
- `backend/internal/handler/collab_authenticator.go` — project membership check
- `backend/internal/handler/thread_ws_handler.go` — `OnDisconnect()`, feed cleanup
