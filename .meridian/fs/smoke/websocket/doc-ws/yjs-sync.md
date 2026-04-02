# Yjs Sync

Subscribe to a document resource on the doc WS to enter Yjs CRDT sync. The server sends sync-step-1 as a binary frame after `subscribed`, the client responds with sync-step-2, and then bidirectional updates flow as binary frames. All binary data uses the `<subId>\x00<payload>` routing prefix.

This validates binary frame transport, Yjs session lifecycle (reference-counted), and cross-connection fanout for collaborative editing.

## How to Reproduce

```bash
# 1. Connect and subscribe to a document in binary mode
./ws-client -token $ACCESS_TOKEN \
  -subscribe document:$DOC_ID \
  -binary \
  ws://localhost:$PORT/ws/projects/$PID/docs
```

**Expected output**:
```
-> sent auth
<- control:connected
-> subscribe document:$DOC_ID (subId=smoke-...)
<- control:subscribed subId=smoke-... {"epoch":"<uuid>"}
<- [binary] subId=smoke-... len=N prefix=0x00
```

The first binary frame is Yjs sync-step-1 (prefix byte `0x00`). In a real client, you'd respond with sync-step-2 and then exchange updates.

**Multi-user sync** — open two clients on the same document:

```bash
# Terminal 1
./ws-client -token $TOKEN_A -subscribe document:$DOC_ID -binary \
  ws://localhost:$PORT/ws/projects/$PID/docs

# Terminal 2
./ws-client -token $TOKEN_B -subscribe document:$DOC_ID -binary \
  ws://localhost:$PORT/ws/projects/$PID/docs

# Edits from Terminal 1 should appear as binary frames in Terminal 2
```

## Expected Behavior

1. `subscribe` with `resource.type: "document"` → handler calls `sessionManager.GetOrCreateSession(docID, userID)`
2. Yjs session is reference-counted — multiple subscribers share the same underlying Yjs doc state
3. `subscribed` returns with a new `epoch` (random UUID per subscription instance)
4. Server sends sync-step-1 as binary frame: `<subId>\x00\x00<yjs-sync-data>`
5. Client sends sync-step-2 as binary frame with the same subId prefix
6. Subsequent edits: client sends binary update → handler calls `syncSession.HandleSyncPayload()` → if update produced, handler broadcasts to all OTHER subscribers of the same document via `broadcastToDocSubscribers()`
7. Binary payload prefix bytes: `0x00` = sync, `0x01` = awareness

### Application-level limits
- Max binary payload: 256KB (matches current per-document WS)
- Framework `ReadLimit`: 256KB for doc WS

## What Failure Looks Like

- **Subscribe returns `SUBSCRIBE_FAILED`**: Document doesn't exist or user doesn't own it. `documentResolver.VerifyOwnership()` failed.
- **No binary frame after `subscribed`**: `BuildSyncStep1Payload()` failed or returned empty. Check session manager initialization.
- **Binary frames arrive but with wrong subId**: Framework routing issue — binary frame prefix extraction may be misaligned.
- **Edits not reaching other subscribers**: `broadcastToDocSubscribers()` not iterating the cross-connection registry, or the source subscriber is being excluded when it shouldn't be (or vice versa).
- **Session reference leak**: If `OnSubscribe` fails after `GetOrCreateSession` but before registration, the deferred release guard should trigger. If it doesn't, sessions accumulate and never GC. Check for the `registered` flag pattern.

## Related Code

- `backend/internal/handler/doc_ws_handler.go` — `DocHandler.OnSubscribe()`, `OnBinaryMessage()`, `broadcastToDocSubscribers()`
- `backend/internal/domain/collab/session.go` — `SyncSession`, `DocumentSessionProvider`
- `backend/internal/service/collab/session_manager.go` — reference-counted session lifecycle
- `backend/internal/wsutil/ws.go` — `SendBinaryToSub()`, binary frame prefix handling
