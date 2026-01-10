---
stack: both
status: complete
feature: "Streaming (SSE)"
---

# Streaming (SSE)

**Server-Sent Events for real-time LLM response streaming with catchup and reconnection.**

## Status: ✅ Complete

---

## Features

**Backend SSE** - Event types, buffer management, PersistAndClear pattern
- See [backend-sse.md](backend-sse.md)

**Frontend Streaming** - useThreadSSE hook, 50ms buffering, stop button
- See [frontend-streaming.md](frontend-streaming.md)

**Catchup/Reconnection** - `Last-Event-ID` header, replay missed events
- See [catchup-reconnection.md](catchup-reconnection.md)

**Race Conditions** - Atomic PersistAndClear prevents buffer loss
- See [race-conditions.md](race-conditions.md)

---

## Event Types

- `turn_start`, `block_start`, `block_delta`, `block_stop`, `block_catchup`, `turn_complete`, `turn_error`

## Delta Types

- `text_delta`, `thinking_delta`, `signature_delta`, `tool_call_start`, `json_delta`, `usage_delta`

---

## Files

**Backend**: `backend/internal/service/llm/streaming/`, `meridian-stream-go/`
**Frontend**: `frontend/src/features/threads/hooks/useThreadSSE.ts`

---

## Related

- See `/_docs/technical/llm/streaming/` for detailed architecture
