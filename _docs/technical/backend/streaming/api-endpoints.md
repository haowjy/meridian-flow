---
detail: standard
audience: developer
---

# Streaming API Endpoints

HTTP and SSE endpoints for real-time LLM response streaming.

## Endpoints Overview

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chats/:id/turns` | POST | Create turn, initiate streaming |
| `/api/turns/:id/stream` | GET | SSE stream of delta events |
| `/api/turns/:id/blocks` | GET | Get completed blocks (reconnection) |
| `/api/turns/:id/interrupt` | POST | Cancel streaming turn |

---

## 1. Create Turn & Start Streaming

**Endpoint:** `POST /api/chats/:chatId/turns`

**Purpose:** Create user turn and initiate assistant response streaming

**Request:**
```json
{
  "prev_turn_id": "uuid-prev-turn",
  "turn_blocks": [
    {
      "block_type": "text",
      "text_content": "Hello, please analyze this code"
    }
  ]
}
```

**Response:**
```json
{
  "user_turn": {
    "id": "uuid-user-turn",
    "role": "user",
    "status": "complete",
    "turn_blocks": [...]
  },
  "assistant_turn": {
    "id": "uuid-assistant-turn",
    "role": "assistant",
    "status": "streaming"
  },
  "stream_url": "/api/turns/uuid-assistant-turn/stream"
}
```

**Status Codes:**
- `201 Created` - Turns created, streaming started
- `400 Bad Request` - Invalid request body
- `404 Not Found` - Chat not found
- `401 Unauthorized` - Chat doesn't belong to user

**Implementation:** `internal/handler/chat.go:181-211`

---

## 2. Stream Turn Events (SSE)

**Endpoint:** `GET /api/turns/:turnId/stream`

**Purpose:** Real-time Server-Sent Events stream of turn deltas

**Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Transfer-Encoding: chunked
X-Accel-Buffering: no
```

**Event Stream:**
```
event: turn_start
data: {"turn_id": "uuid-123", "model": "claude-haiku-4-5-20251001"}

event: block_start
data: {"block_index": 0, "block_type": "thinking"}

event: block_delta
data: {"block_index": 0, "delta": {"text": "Let me"}}

event: block_delta
data: {"block_index": 0, "delta": {"text": " think"}}

event: block_stop
data: {"block_index": 0}

event: block_start
data: {"block_index": 1, "block_type": "text"}

event: block_delta
data: {"block_index": 1, "delta": {"text": "Based on"}}

event: block_stop
data: {"block_index": 1}

event: turn_complete
data: {"status": "complete", "output_tokens": 420}
```

**Event Types:**

| Event | Purpose | Data |
|-------|---------|------|
| `turn_start` | Turn begins | turn_id, model, timestamp |
| `block_start` | New block starts | block_index, block_type |
| `block_delta` | Content delta | block_index, delta object |
| `block_stop` | Block complete | block_index |
| `block_catchup` | Reconnection catchup | accumulated content |
| `turn_complete` | Turn finished | status, tokens, stop_reason |
| `turn_error` | Error occurred | error message, code |

**Keepalive:**
- Comment sent every 15 seconds: `: keepalive\n\n`
- Prevents connection timeout
- Client should ignore comments

**Implementation:** `internal/handler/sse_handler.go:31-200`

---

## 3. Get Completed Turn Blocks

**Endpoint:** `GET /api/turns/:turnId/blocks`

**Purpose:** Fetch completed blocks for reconnection or history

**Response:**
```json
{
  "turn_id": "uuid-assistant-turn",
  "status": "streaming",
  "current_block_index": 2,
  "blocks": [
    {
      "id": "uuid-block-1",
      "sequence": 0,
      "block_type": "thinking",
      "text_content": "Let me think about this...",
      "created_at": "2025-11-09T10:30:01Z"
    },
    {
      "id": "uuid-block-2",
      "sequence": 1,
      "block_type": "text",
      "text_content": "Based on my analysis,",
      "created_at": "2025-11-09T10:30:05Z"
    }
  ]
}
```

**Use Cases:**
- Client reconnects after disconnect
- Client wants to render completed content before streaming
- Historical turn retrieval

**Status Codes:**
- `200 OK` - Blocks retrieved
- `404 Not Found` - Turn not found
- `401 Unauthorized` - Unauthorized access

**Implementation:** `internal/handler/chat.go:286-308`

---

## 4. Interrupt Turn

**Endpoint:** `POST /api/turns/:turnId/interrupt`

**Purpose:** Cancel streaming turn (user clicks "Stop")

**Response:**
```json
{
  "turn_id": "uuid-assistant-turn",
  "status": "cancelled",
  "blocks_completed": 2,
  "message": "Turn interrupted by user"
}
```

**Behavior:**
- Cancels context for LLM provider stream
- Writes partial accumulated block to database
- Updates turn status to "cancelled"
- Broadcasts turn_cancelled event to all SSE clients

**Status Codes:**
- `200 OK` - Turn interrupted
- `404 Not Found` - Turn not streaming
- `400 Bad Request` - Invalid turn ID

**Implementation:** `internal/handler/chat.go:310-344`

---

## SSE Event Details

### turn_start

```json
{
  "turn_id": "uuid-123",
  "chat_id": "uuid-456",
  "role": "assistant",
  "model": "claude-haiku-4-5-20251001",
  "timestamp": "2025-11-09T10:30:00Z"
}
```

### block_start

```json
{
  "turn_id": "uuid-123",
  "block_index": 0,
  "block_type": "thinking"
}
```

### block_delta

**Text/Thinking:**
```json
{
  "turn_id": "uuid-123",
  "block_index": 0,
  "block_type": "thinking",
  "delta": {
    "text": "Let me analyze"
  }
}
```

**Tool Use (JSON streaming):**
```json
{
  "turn_id": "uuid-123",
  "block_index": 1,
  "block_type": "tool_use",
  "delta": {
    "partial_json": "{\"tool_name\": \"read"
  }
}
```

### block_stop

```json
{
  "turn_id": "uuid-123",
  "block_index": 0,
  "block_type": "thinking"
}
```

### block_catchup

**Sent on reconnection - accumulated content:**
```json
{
  "turn_id": "uuid-123",
  "block_index": 2,
  "block_type": "text",
  "accumulated_text": "I found several issues that need"
}
```

### turn_complete

```json
{
  "turn_id": "uuid-123",
  "status": "complete",
  "stop_reason": "end_turn",
  "input_tokens": 150,
  "output_tokens": 420,
  "total_blocks": 3
}
```

### turn_error

```json
{
  "turn_id": "uuid-123",
  "error": "Rate limit exceeded",
  "code": "rate_limit_error",
  "blocks_completed": 2
}
```

---

## Client Integration

### Basic SSE Client

```typescript
const eventSource = new EventSource(`/api/turns/${turnId}/stream`);

eventSource.addEventListener('turn_start', (event) => {
  const data = JSON.parse(event.data);
  console.log('Turn started:', data.model);
});

eventSource.addEventListener('block_start', (event) => {
  const data = JSON.parse(event.data);
  // Initialize new block in UI
});

eventSource.addEventListener('block_delta', (event) => {
  const data = JSON.parse(event.data);
  // Append delta.text to block
});

eventSource.addEventListener('block_stop', (event) => {
  // Block complete
});

eventSource.addEventListener('turn_complete', (event) => {
  const data = JSON.parse(event.data);
  console.log('Turn complete:', data.output_tokens, 'tokens');
  eventSource.close();
});

eventSource.addEventListener('turn_error', (event) => {
  const data = JSON.parse(event.data);
  console.error('Turn error:', data.error);
  eventSource.close();
});

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  eventSource.close();
};
```

### Reconnection Pattern

```typescript
async function connectToStream(turnId: string) {
  // 1. Fetch completed blocks first
  const response = await fetch(`/api/turns/${turnId}/blocks`);
  const { blocks, status } = await response.json();

  // 2. Render completed blocks
  renderBlocks(blocks);

  // 3. If still streaming, connect to SSE
  if (status === 'streaming') {
    const eventSource = new EventSource(`/api/turns/${turnId}/stream`);

    // Handle catchup event
    eventSource.addEventListener('block_catchup', (event) => {
      const data = JSON.parse(event.data);
      // Render accumulated content for current block
      renderCatchupBlock(data);
    });

    // Handle live deltas
    eventSource.addEventListener('block_delta', (event) => {
      const data = JSON.parse(event.data);
      appendDelta(data);
    });

    // ... other event handlers
  }
}
```

---

## Performance Characteristics

| Operation | Latency | Bandwidth |
|-----------|---------|-----------|
| POST /turns | <500ms | ~2KB |
| GET /stream (connect) | <100ms | - |
| SSE event | <50ms | ~200B/event |
| Keepalive | Every 15s | 15B |
| GET /blocks | <300ms | ~10KB (10 blocks) |

---

## References

**Implementation:**
- SSE handler: `internal/handler/sse_handler.go`
- Turn handler: `internal/handler/chat.go:181-344`
- Executor: `internal/service/llm/streaming/executor.go`

**Related:**
- [Streaming Architecture](../architecture/streaming-architecture.md)
- [Edge Cases](edge-cases.md)
- [Tool Execution](tool-execution.md)
