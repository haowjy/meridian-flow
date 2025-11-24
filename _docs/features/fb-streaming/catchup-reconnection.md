---
stack: both
status: complete
feature: "Catchup and Reconnection"
---

# Catchup and Reconnection

**`Last-Event-ID` header for replaying missed events.**

## Status: ✅ Complete

---

## Backend

**Catchup Mechanism**: `backend/internal/service/llm/streaming/catchup.go`

**Flow**:
1. Client sends `Last-Event-ID: 123` header
2. Server checks buffer for events after ID 123
3. Sends `block_catchup` events for missed blocks
4. Resumes normal streaming

**Event IDs**: Sequential (only in DEBUG mode), used for ordering

---

## Frontend

**Auto-Reconnect**: `@microsoft/fetch-event-source` handles reconnection

**Last-Event-ID**: Library automatically sends header on reconnect

**Graceful Degradation**: If catchup fails, fetches completed blocks via API

---

## Related

- See [backend-sse.md](backend-sse.md) for event types
- See [frontend-streaming.md](frontend-streaming.md) for client implementation
