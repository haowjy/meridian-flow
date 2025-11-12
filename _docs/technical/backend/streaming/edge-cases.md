---
detail: standard
audience: developer
---

# Streaming Edge Cases & Error Handling

Error handling strategies and edge case behavior for production streaming.

## 1. Client Disconnects During Streaming

**Scenario:** User closes browser tab or loses network connection mid-stream

**Behavior:**
- ✅ Backend goroutine continues streaming & accumulating
- ✅ Completed blocks written to database as normal
- ✅ Current block remains in memory (accumulator)
- ✅ On reconnection, client receives catchup + resumes live

**Why continue streaming?**
- Preserves LLM response (paid for tokens)
- Enables seamless reconnection
- User can return and see complete response

**Implementation:**
```go
func (e *TurnExecutor) BroadcastDelta(delta TurnBlockDelta) {
    e.mu.Lock()
    defer e.mu.Unlock()

    // Remove disconnected clients
    activeClients := make([]*SSEClient, 0, len(e.sseClients))
    for _, client := range e.sseClients {
        if client.IsConnected() {
            client.Send("block_delta", delta)
            activeClients = append(activeClients, client)
        }
    }
    e.sseClients = activeClients
}
```

**Detection:** Flush error when writing to SSE stream

---

## 2. Multiple Clients Streaming Same Turn

**Scenario:** User opens same conversation in multiple browser tabs

**Behavior:**
- ✅ Each tab maintains separate SSE connection
- ✅ All tabs receive same delta events
- ✅ Database writes happen once (by TurnExecutor)
- ✅ All tabs stay synchronized

**Implementation:**
```go
type TurnExecutorRegistry struct {
    executors map[string]*TurnExecutor
    mu        sync.RWMutex
}

func (r *TurnExecutorRegistry) GetOrCreateExecutor(turnID string) *TurnExecutor {
    r.mu.Lock()
    defer r.mu.Unlock()

    if executor, exists := r.executors[turnID]; exists {
        return executor // Reuse existing executor
    }

    executor := NewTurnExecutor(turnID)
    r.executors[turnID] = executor
    return executor
}
```

**Registry pattern ensures:**
- One goroutine per turn (not per client)
- Shared executor broadcasts to all clients
- Efficient resource usage

---

## 3. Database Write Failure

**Scenario:** PostgreSQL error when writing TurnBlock

**Behavior:**
- ❌ Streaming pauses
- ✅ Retry write once (100ms delay)
- ✅ If retry fails, send `turn_error` event to all clients
- ✅ Update turn status to "error"
- ✅ Preserve accumulated content in memory for recovery

**Implementation:**
```go
func (e *TurnExecutor) WriteBlock(block TurnBlock) error {
    err := e.repo.CreateTurnBlocks(ctx, []TurnBlock{block})

    if err != nil {
        // Retry once
        time.Sleep(100 * time.Millisecond)
        err = e.repo.CreateTurnBlocks(ctx, []TurnBlock{block})

        if err != nil {
            // Send error to clients
            e.BroadcastError("database_error", err.Error())
            e.UpdateTurnStatus("error")
            return fmt.Errorf("failed to write block: %w", err)
        }
    }

    return nil
}
```

**Why retry?**
- Transient network issues
- Brief connection pool exhaustion
- 100ms delay allows recovery

**Recovery:**
- Content remains in memory
- Manual retry possible via debug endpoint
- Database transaction logs preserve data

---

## 4. LLM Provider Error

**Scenario:** Anthropic API returns error mid-stream (rate limit, auth, etc.)

**Behavior:**
- ✅ Write accumulated block (if any)
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
- ✅ Cancel context to stop LLM provider stream
- ✅ Write accumulated block (partial content)
- ✅ Update turn status to "cancelled"
- ✅ Send `turn_cancelled` event to all clients

**API Call:**
```http
POST /api/turns/abc-123/interrupt

Response:
{
  "turn_id": "abc-123",
  "status": "cancelled",
  "blocks_completed": 2,
  "partial_block": {
    "sequence": 2,
    "block_type": "text",
    "text_content": "I was analyzing the code and found"
  }
}
```

**Implementation:**
```go
func (e *TurnExecutor) Interrupt() {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.cancelled {
        return // Already cancelled
    }

    e.cancelled = true
    e.cancelFunc() // Cancel context

    // Write partial block if exists
    if e.accumulator != nil && e.accumulator.HasContent() {
        e.WriteBlock(e.accumulator.BuildBlock())
    }

    // Update status
    e.UpdateTurnStatus("cancelled")

    // Notify clients
    e.BroadcastEvent("turn_cancelled", fiber.Map{
        "turn_id": e.turnID,
        "status":  "cancelled",
    })
}
```

**Partial block preservation:**
- User sees partial response in history
- Can resume from partial or create new branch
- No lost content

---

## 6. Orphaned Streaming Goroutines

**Scenario:** All clients disconnect but goroutine keeps streaming

**Behavior:**
- ✅ Continue streaming until completion
- ✅ Write all blocks to database
- ✅ Clean up goroutine after turn completes
- ✅ Timeout after 5 minutes if no completion

**Why continue?**
- Preserve LLM response (tokens already charged)
- User might return
- No dangling incomplete turns

**Implementation:**
```go
func (e *TurnExecutor) StreamWithTimeout() error {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer cancel()

    errChan := make(chan error, 1)

    go func() {
        errChan <- e.Stream(ctx)
    }()

    select {
    case err := <-errChan:
        return err
    case <-ctx.Done():
        e.UpdateTurnStatus("error")
        return fmt.Errorf("streaming timeout")
    }
}
```

**Cleanup:**
```go
func (r *TurnExecutorRegistry) Cleanup() {
    r.mu.Lock()
    defer r.mu.Unlock()

    for turnID, executor := range r.executors {
        if executor.IsComplete() && time.Since(executor.CompletedAt()) > 10*time.Minute {
            delete(r.executors, turnID)
            executor.Close()
        }
    }
}
```

**Runs every 5 minutes via ticker**

---

## 7. Turn Already Complete

**Scenario:** Client connects to SSE for already-completed turn

**Behavior:**
- ✅ Immediately send `turn_complete` event
- ✅ Include summary metadata
- ✅ Close SSE connection
- ✅ Client should fetch blocks via REST API

**SSE Event:**
```json
{
  "event": "turn_complete",
  "data": {
    "turn_id": "abc-123",
    "status": "complete",
    "total_blocks": 5,
    "output_tokens": 850,
    "message": "Turn already completed. Fetch blocks via GET /api/turns/:id/blocks"
  }
}
```

**Implementation:**
```go
func (h *SSEHandler) StreamTurn(c *fiber.Ctx) error {
    turnID := c.Params("id")

    executor := h.registry.Get(turnID)
    if executor == nil {
        // Check if turn is already complete
        turn, err := h.turnRepo.GetByID(ctx, turnID)
        if err == nil && turn.Status == "complete" {
            // Send complete event immediately
            event := TurnCompleteEvent{
                TurnID:       turnID,
                Status:       "complete",
                TotalBlocks:  len(turn.TurnBlocks),
                OutputTokens: turn.OutputTokens,
            }
            c.Set("Content-Type", "text/event-stream")
            c.WriteString(formatSSEEvent("turn_complete", event))
            return nil
        }

        return fiber.NewError(404, "Turn not found or not streaming")
    }

    // Normal streaming flow...
}
```

---

## 8. Context Cancellation Not Checked

**Problem:** Streaming loop doesn't check context cancellation

**Impact:**
- Goroutine leaks
- Wasted LLM API calls
- Server resource exhaustion

**Fix:**
```go
func (e *TurnExecutor) Stream(ctx context.Context) error {
    streamChan, err := e.generator.GenerateResponse(ctx, e.turnID, params)
    if err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            // Context cancelled - handle graceful shutdown
            e.handleError(fmt.Errorf("streaming interrupted: %w", ctx.Err()))
            return ctx.Err()

        case streamEvent, ok := <-streamChan:
            if !ok {
                e.handleError(fmt.Errorf("stream closed without metadata"))
                return nil
            }
            // Process event...
        }
    }
}
```

**Fixes:**
- Cancelled contexts immediately exit loop
- No goroutine leaks
- Provider stream cancelled

---

## 9. SSE Connection Buffering

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

## 10. Accumulator State Corruption

**Problem:** Race condition when multiple goroutines access accumulator

**Solution:** Mutex protection

```go
type BlockAccumulator struct {
    mu           sync.Mutex
    TurnID       string
    BlockIndex   int
    BlockType    string
    TextBuffer   strings.Builder
    ContentData  map[string]interface{}
}

func (a *BlockAccumulator) HandleDelta(delta TurnBlockDelta) error {
    a.mu.Lock()
    defer a.mu.Unlock()

    // Safe to access state
    if delta.BlockType != a.BlockType {
        a.WriteToDatabase()
        a.Reset(delta.BlockIndex, delta.BlockType)
    }

    if text, ok := delta.Delta["text"].(string); ok {
        a.TextBuffer.WriteString(text)
    }

    return nil
}
```

---

## Testing Edge Cases

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
- Executor: `internal/service/llm/streaming/executor.go`
- SSE handler: `internal/handler/sse_handler.go`
- Registry: `internal/service/llm/streaming/registry.go`

**Related:**
- [Streaming Architecture](../architecture/streaming-architecture.md)
- [API Endpoints](api-endpoints.md)
- [Service Layer](../architecture/service-layer.md)
