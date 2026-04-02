# Auth and Heartbeat

JWT authentication is mandatory on connect (first message, 5s deadline). After auth, the framework runs heartbeat at 20s intervals, re-checking both JWT expiry AND project membership on each cycle. Failed re-auth tears down the entire connection.

## How to Reproduce

### Successful auth

```bash
./ws-client -token $ACCESS_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output**:
```
-> sent auth
<- control:connected {"connectionId":"..."}
<- ping -> pong
<- ping -> pong
...
```

### Bad auth

```bash
./ws-client -bad-auth \
  ws://localhost:$PORT/ws/projects/$PID/threads
```

**Expected output**:
```
-> sent auth
<- error:error {"code":"AUTH_FAILED","message":"..."}
read error: ...  (connection closed)
```

### Heartbeat re-auth

```bash
# 1. Connect with a valid token
./ws-client -token $ACCESS_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/threads

# 2. While connected, revoke the user's project access
#    (e.g., remove from project members via admin API or DB)

# 3. Wait up to 20s for next heartbeat cycle
```

**Expected output after revocation**:
```
<- ping -> pong   (re-auth passed)
...
# After access revoked:
read error: ...   (connection closed by server within ~20s)
```

### Auth timeout (no auth sent)

```bash
# Connect without sending auth — use a raw WS client or modify toy client
# Server closes connection after 5s with no auth frame
```

## Expected Behavior

1. **First message must be auth**: `{"kind":"control","op":"auth","payload":{"token":"jwt..."}}`
2. **5-second deadline**: `BootstrapAuth()` uses `context.WithTimeout(ctx, 5s)`. No auth frame → `ErrAuthTimeout` → connection closed.
3. **Auth verifies**: JWT signature + expiry via `Authenticator.Authenticate()`, then `CheckProjectAccess(userID, projectID)`
4. **Connected response**: `{"kind":"control","op":"connected","payload":{"connectionId":"..."}}`
5. **Heartbeat loop**: Server sends `ping` every 20s, expects `pong` within 20s
6. **Re-auth on each heartbeat**: Checks JWT expiry AND calls `CheckProjectAccess()` again
7. **Failed re-auth**: Connection closed. All subscriptions terminated (`EndSub` for each → `OnUnsubscribe` → `OnDisconnect`).

### Auth checks by operation

| Operation | Auth check |
|---|---|
| Connect | JWT + `CanAccessProject` |
| Heartbeat | JWT expiry + `CanAccessProject` (re-check) |
| Subscribe | `CanAccessTurn` or `VerifyOwnership` per subscribe |
| Interjection | `CanAccessTurn` per message |

## What Failure Looks Like

- **`AUTH_FAILED` error frame**: JWT invalid, expired, or user not a project member. Check token and project membership.
- **Connection closes silently after ~20s**: Heartbeat re-auth failed. User lost project access or JWT expired. Server logs `authentication expired` or `project access check failed`.
- **No heartbeat pings**: Heartbeat loop not started. Check that `WithHeartbeat(20s, 20s)` is passed to `NewServer`.
- **Connection stays alive after access revocation**: Re-auth not checking project membership. `CheckProjectAccess` must be called on every heartbeat, not just JWT expiry.

## Related Code

- `backend/internal/wsutil/auth.go` — `BootstrapAuth()`, `Authenticator` interface, `AuthResult`
- `backend/internal/wsutil/ws.go` — heartbeat loop, re-auth on each cycle
- `backend/internal/handler/collab_authenticator.go` — concrete `Authenticator` implementation
- `backend/internal/handler/doc_ws_authenticator.go` — doc WS authenticator
