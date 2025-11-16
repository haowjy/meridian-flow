---
detail: standard
audience: developer
---

# Streaming Edge Cases & Error Handling

Error handling strategies and edge case behavior for production streaming.

## 1. Client Disconnects During Streaming

**Scenario:** User closes browser tab or loses network connection mid-stream

**Behavior:**
- ✅ Backend streaming continues in the background
- ✅ Completed blocks written to database as normal
- ✅ `mstream.Stream` keeps recent events in an in-memory buffer
- ✅ On reconnection, client receives catchup events + resumes live

**Why continue streaming?**
- Preserves LLM response (paid for tokens)
- Enables seamless reconnection
- User can return and see complete response

**Implementation (conceptual):**
- `StreamExecutor` keeps streaming from the provider, persisting completed blocks.
- `mstream.Stream` holds events for catchup; `SSEHandler` uses `GetCatchupEvents(lastEventID)` on reconnect.

---

## 2. Multiple Clients Streaming Same Turn

**Scenario:** User opens same conversation in multiple browser tabs

**Behavior:**
- ✅ Each tab maintains separate SSE connection
- ✅ All tabs receive same delta events
- ✅ Database writes happen once (by `StreamExecutor` / `TurnRepository`)
- ✅ All tabs stay synchronized

**Implementation:**
- `mstream.Registry` holds a single `Stream` per turn.
- Each SSE connection calls `stream.AddClient(clientID)` to receive events; `StreamExecutor` writes events once.

---

## 3. Database Write Failure

**Scenario:** PostgreSQL error when writing TurnBlock

**Behavior:**
- ❌ Streaming cannot safely continue writing new blocks
- ✅ `StreamExecutor.handleError` sends `turn_error` event to all clients
- ✅ Turn status updated to `"error"` via `UpdateTurnError`
- ✅ Error stored in turn record for debugging

---

## 4. LLM Provider Error

**Scenario:** Anthropic API returns error mid-stream (rate limit, auth, etc.)

**Behavior:**
- ✅ Send `turn_error` event with error details
- ✅ Update turn status to "error"
- ✅ Store error message in turn record

**SSE Event:**
```json
{
  "event": "turn_error",
  "data": {
    "turn_id": "uuid-abc",
    "error": "Rate limit exceeded",
    "code": "rate_limit_error",
    "blocks_completed": 2
  }
}
```

**Turn Record:**
```sql
UPDATE turns
SET status = 'error',
    error = 'Rate limit exceeded (code: rate_limit_error)',
    completed_at = NOW()
WHERE id = 'uuid-abc';
```

**Common errors:**
- `rate_limit_error` - Too many requests
- `authentication_error` - Invalid API key
- `overloaded_error` - Provider capacity
- `invalid_request_error` - Malformed request

---

## 5. User Interrupts Turn

**Scenario:** User clicks "Stop" button during streaming

**Behavior:**
- (Planned) Cancel context to stop provider stream via `StreamExecutor`
- (Planned) Update turn status to `"cancelled"` and stop emitting events
- (Planned) Optionally persist partial blocks depending on UX decisions

Implementation details for interrupt are evolving; see backend API docs for the current behavior.

---

## 6. Orphaned Streaming Goroutines

**Scenario:** All clients disconnect but goroutine keeps streaming

**Behavior:**
- ✅ Continue streaming until completion even if all clients disconnect
- ✅ Write all blocks to database
- ✅ `mstream.Registry` cleanup loop removes old streams after retention timeout

**Why continue?**
- Preserve LLM response (tokens already charged)
- User might return
- No dangling incomplete turns

**Implementation:** `mstream.Registry.StartCleanup` goroutine

---

## 7. Turn Already Complete

**Scenario:** Client connects to SSE for already-completed turn

**Behavior:**
- ✅ SSE handler checks `stream.Status()` when a client connects
- ✅ If finished, connection ends after any remaining events are replayed
- ✅ Client should fetch blocks via REST (`GET /api/turns/:id` or `/blocks`)

---

## 8. SSE Connection Buffering

**Problem:** Nginx buffers SSE events, client sees delayed updates

**Solution:** Set `X-Accel-Buffering: no` header

```go
func (h *SSEHandler) StreamTurn(c *fiber.Ctx) error {
    c.Set("Content-Type", "text/event-stream")
    c.Set("Cache-Control", "no-cache")
    c.Set("Connection", "keep-alive")
    c.Set("Transfer-Encoding", "chunked")
    c.Set("X-Accel-Buffering", "no") // Disable nginx buffering

    // Stream events...
}
```

**Also ensure:**
- Flush after each event write
- Regular keepalive comments
- Client EventSource properly configured

---

## 9. Testing Edge Cases

**Unit Tests:**
```go
func TestExecutor_ClientDisconnect(t *testing.T) {
    // Simulate client disconnect
    // Verify streaming continues
    // Verify blocks persisted
}

func TestExecutor_DatabaseError(t *testing.T) {
    // Mock repository error
    // Verify retry logic
    // Verify error event sent
}

func TestExecutor_Interrupt(t *testing.T) {
    // Call Interrupt()
    // Verify context cancelled
    // Verify partial block saved
}
```

**Integration Tests:**
```go
func TestSSE_Reconnection(t *testing.T) {
    // Connect to SSE
    // Disconnect mid-stream
    // Reconnect
    // Verify catchup events
    // Verify no duplicate blocks
}
```

---

## References

**Implementation:**
- StreamExecutor + catchup: `backend/internal/service/llm/streaming/mstream_adapter.go`, `catchup.go`
- SSE handler: `internal/handler/sse_handler.go`
- Registry: `github.com/haowjy/meridian-stream-go` (wrapped in `backend/internal/service/llm/setup.go`)

**Related:**
- [Streaming Architecture](../architecture/streaming-architecture.md)
- [API Endpoints](api-endpoints.md)
- [Service Layer](../architecture/service-layer.md)
