---
stack: frontend
status: complete
feature: "Frontend Streaming"
---

# Frontend Streaming

**useChatSSE hook with buffered rendering and stop button.**

## Status: ✅ Complete

---

## Implementation

**Hook**: `frontend/src/features/chats/hooks/useChatSSE.ts`

**Library**: `@microsoft/fetch-event-source`

---

## Features

**50ms Buffered Rendering**: Text deltas buffered for smooth rendering (avoids jank)

**Buffer Hook**: `frontend/src/features/chats/hooks/useStreamingBuffer.ts`

**Stop Button**: Cancels streaming via AbortController

**Auto-Reconnect**: Library handles reconnection with exponential backoff

**Error Handling**: 4xx = no retry, 5xx = retry

---

## Event Processing

**Flow**:
1. Receive SSE event
2. Parse event type
3. Update local state (blocks, deltas)
4. Buffer text deltas (50ms)
5. Render to UI

---

## Cleanup

**AbortController**: Cleanup on unmount, prevents memory leaks

**Connection Health**: Zero-byte writes detect disconnection

---

## Related

- See [backend-sse.md](backend-sse.md) for server implementation
- See [catchup-reconnection.md](catchup-reconnection.md) for reconnection
