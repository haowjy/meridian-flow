# WebSocket Smoke Tests

When working on WebSocket code (wsutil framework, thread WS handler, doc WS handler, frontend WS providers), use these smoke tests to verify behavior that automated tests can't easily cover.

## Setup

```bash
# Start dev environment
./scripts/dev/setup.sh
source scripts/get-token.sh

# Install toy client deps
cd .meridian/fs/smoke/websocket/client && npm install && cd -
```

## Toy Client

`client/ws-client.mjs` — Node.js WS client with flags for each edge case:

```bash
# Basic connection + auth
node client/ws-client.mjs ws://localhost:$PORT/ws/projects/$PID/threads --token $TOKEN

# Subscribe to a turn stream
node client/ws-client.mjs ws://localhost:$PORT/ws/projects/$PID/threads --token $TOKEN --subscribe turn:$TURN_ID

# Subscribe to a document (Yjs binary frames)
node client/ws-client.mjs ws://localhost:$PORT/ws/projects/$PID/docs --token $TOKEN --subscribe document:$DOC_ID --binary

# Reconnect with catchup
node client/ws-client.mjs ws://localhost:$PORT/ws/projects/$PID/threads --token $TOKEN --subscribe turn:$TURN_ID --last-seq 42 --epoch $EPOCH

# Edge case flags
--flood 50         # Send 50 messages rapidly (rate limit test)
--no-pong          # Don't respond to pings (heartbeat timeout test)
--freeze-after 5   # Stop reading after 5 events (backpressure test)
--bad-auth         # Send invalid JWT (auth error test)
--interject "text" # Send interjection to subscribed turn
```

## Test Areas

| Area | Directory | What to test |
|------|-----------|-------------|
| Thread WS | `thread-ws/` | Streaming lifecycle, interjections, stream switch, spawn discovery |
| Doc WS | `doc-ws/` | Notify invalidation, Yjs sync, document multiplexing |
| Framework | `framework/` | Auth/heartbeat, rate limiting |
| Edge Cases | `edge-cases/` | Backpressure, reconnection, livelock prevention, panic recovery |

## After Code Changes

1. Pick the test files relevant to what you changed
2. Follow the reproduction steps with the toy client
3. Verify expected behavior matches
4. If anything fails, fix before marking the work done

## Key Files Being Tested

| Component | Location |
|-----------|----------|
| wsutil framework | `backend/internal/wsutil/` |
| Thread WS handler | `backend/internal/handler/thread_ws_handler.go` |
| Doc WS handler | `backend/internal/handler/doc_ws_handler.go` |
| InterjectionForwarder | `backend/internal/service/llm/streaming/interjection_forwarder.go` |
| Frontend ThreadWsProvider | `frontend-v2/src/lib/ws/` |
| Frontend DocStreamClient | `frontend-v2/src/lib/ws/doc-stream-client.ts` |
