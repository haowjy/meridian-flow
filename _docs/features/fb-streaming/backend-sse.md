---
stack: backend
status: complete
feature: "Backend SSE Implementation"
---

# Backend SSE Implementation

**Server-Sent Events for real-time LLM streaming.**

## Status: ✅ Complete

---

## Event Types

- `turn_start` - Turn streaming begun
- `block_start` - New block started
- `block_delta` - Incremental block content
- `block_stop` - Block finished
- `block_catchup` - Replay completed block (reconnection)
- `turn_complete` - Turn finished successfully
- `turn_error` - Turn encountered error

**File**: `backend/internal/domain/models/llm/sse_events.go`

---

## Delta Types

- `text_delta` - Regular text content
- `thinking_delta` - Thinking/reasoning text
- `signature_delta` - Cryptographic signature (Extended Thinking)
- `tool_call_start` - Tool call initiated (name, id)
- `json_delta` - Incremental JSON (tool input, results)
- `usage_delta` - Token usage updates

**File**: `backend/internal/domain/models/llm/turn_block_delta.go`

---

## Buffer Management

**Library**: `meridian-stream-go`

**Features**:
- In-memory event buffer during active stream
- Atomic persist-and-clear pattern (prevents race conditions)
- Buffer cleared after stream completion

**Pattern**: `stream.PersistAndClear(func(events) { saveToDb })`

---

## Endpoint

`GET /api/turns/{id}/stream` - SSE streaming endpoint

**Headers**: `Last-Event-ID` for catchup

---

## Related

- See [race-conditions.md](race-conditions.md) for PersistAndClear pattern
- See [catchup-reconnection.md](catchup-reconnection.md) for reconnection
- See `/_docs/technical/llm/streaming/` for detailed architecture
