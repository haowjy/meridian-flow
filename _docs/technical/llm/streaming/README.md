---
detail: minimal
audience: backend developers
---

# Backend Streaming System

Real-time LLM response delivery via Server-Sent Events (SSE) with turn block accumulation and database persistence.

**Note:** This describes **backend streaming implementation** (SSE, catchup, persistence). For **library-level streaming** (StreamEvent, BlockDelta), see:
- [meridian-llm-go/docs/streaming.md](../../../../meridian-llm-go/docs/streaming.md)
- [meridian-llm-go/docs/blocks.md](../../../../meridian-llm-go/docs/blocks.md)

## Quick Links

**First time?** -> [Streaming Architecture](../../backend/architecture/service-layer.md)
**AG-UI protocol?** -> [AG-UI Protocol Reference](ag-ui-protocol.md) | [Meridian Bridge](meridian-agui-bridge.md)
**API integration?** -> [API Endpoints](api-endpoints.md)
**Tool calling?** -> [Tool Execution](tool-execution.md)
**Troubleshooting?** -> [Edge Cases](edge-cases.md)

---

## System Overview

```mermaid
graph TB
    Client[Client<br/>Browser]
    SSE[SSE Handler<br/>Server-Sent Events]
    Stream[StreamingService<br/>Orchestration]
    MStream[mstream.Registry<br/>Active Streams]
    Executor[StreamExecutor<br/>mstream Worker]
    Provider[LLM Provider<br/>via meridian-llm-go]
    DB[(PostgreSQL<br/>Turn Blocks)]

    Client -->|POST /threads/:id/turns| Stream
    Stream -->|Create StreamExecutor<br/>+ mstream.Stream| MStream

    Client -->|GET /turns/:id/stream| SSE
    SSE -->|Get stream| MStream
    MStream -->|Catchup + SSE events| SSE
    SSE -->|SSE events| Client

    Executor -->|StreamResponse| Provider
    Provider -->|StreamEvents<br/>(Delta, Block, Metadata)| Executor
    Executor -->|TurnBlockDelta events| MStream
    Executor -->|Persist TurnBlock| DB

```

---

## Key Concepts

### TurnBlockDelta vs TurnBlock

**TurnBlockDelta** (Ephemeral)
- Real-time streaming updates
- Sent via SSE to clients
- **Not persisted** to database
- Exists only during active streaming

**TurnBlock** (Persisted)
- Accumulated complete content
- Stored in PostgreSQL
- Permanent conversation history
- Retrieved via REST API

### Accumulation Rule

- Provider-specific events are normalized and **accumulated in `meridian-llm-go`**, not in the backend.
- The library emits complete `Block` structs when a provider block finishes.
- Backend persists those blocks as `TurnBlock`s and only uses deltas for real-time UI.

### Tool Input Streaming Limitations

Anthropic's API **intentionally buffers tool input JSON** before sending `input_json_delta` events. From Anthropic's docs:

> "Our current models only support emitting one complete key and value property from input at a time. As such, when using tools, there may be delays between streaming events while the model is working."

**Observed behavior:**
- Keep-alive events arrive every 5 seconds during buffering
- Tool args (`input_json_delta`) arrive in bursts after buffering
- This is especially noticeable for large args like text editor tool content

**This is expected behavior, not a bug.**

**OpenRouter note:** When using OpenRouter, this buffering behavior depends on the underlying provider. Some providers may buffer tool inputs similarly; others may stream more granularly.

#### Future Option

Anthropic offers a beta feature (`fine-grained-tool-streaming-2025-05-14` header) that disables buffering, but:
- May produce invalid/partial JSON
- Requires additional error handling
- Still in beta as of May 2025

---

## Documentation

### Core Concepts

**[Streaming Architecture](../../backend/architecture/service-layer.md)** (~600 lines)
- Overview of streaming system
- TurnBlockDelta vs TurnBlock explained
- Data models (SSE event types)
- Normal streaming flow diagrams
- Accumulation & persistence logic
- Client reconnection strategy
- Multi-provider abstraction

**When to read:** Understanding core streaming concepts, architecture overview

---

**[Block Types Reference](../../backend/thread/turn-blocks.md)** (~300 lines)
- Complete list of TurnBlock types (text, thinking, tool_use, etc.)
- Delta type reference and accumulation mapping
- SSE event type summary
- Content structure schemas (JSONB)
- Validation rules
- Meridian extensions vs library types

**When to read:** Implementing UI for blocks, parsing SSE events, understanding content schemas

---

### AG-UI Protocol

**[AG-UI Protocol Reference](ag-ui-protocol.md)** (~150 lines)
- AG-UI event types (text, thinking, tool, lifecycle)
- ID semantics (runId, messageId, toolCallId, etc.)
- Event flow diagrams
- SSE format specification

**When to read:** Understanding the streaming event protocol, debugging event correlation

---

**[Meridian AG-UI Bridge](meridian-agui-bridge.md)** (~200 lines)
- Full-stack integration (Library -> Backend -> Frontend)
- IDFactory and Emitter components
- BlockTracker for frontend correlation
- Meridian-specific extensions (turn_complete, turn_error)

**When to read:** Understanding cross-layer event flow, implementing new event types

---

### Specialized Topics

**[Executor State Machine](executor-state-machine.md)** (~100 lines)
- Actor pattern and state transitions
- Soft cancel vs hard cancel flows
- Command channel (`CmdSoftCancel`, `CmdHardCancel`)
- State behaviors (AllowsPersistence, AllowsSSE)

**When to read:** Understanding cancellation, debugging state issues

---

**[Race Conditions](race-conditions.md)** (~180 lines)
- Buffer clear race condition & fix
- Catchup coordination mutex
- DEBUG mode for event IDs
- Atomic PersistAndClear pattern
- Sequence diagrams of fixes

**When to read:** Understanding reliability fixes, debugging reconnection issues

---

**[Tool Execution](tool-execution.md)** (~180 lines)
- Complete tool call cycle
- TurnBlock sequence with tools
- Multiple tool calls handling
- Tool result propagation

**When to read:** Implementing tool calling, debugging tool execution

---

**[API Endpoints](api-endpoints.md)** (~200 lines)
- SSE endpoint details
- Event types reference
- Request/response examples
- Integration guide

**When to read:** Frontend integration, API contracts

---

**[Edge Cases](edge-cases.md)** (~200 lines)
- Client disconnects
- Database write failures
- LLM provider errors
- User interrupts
- Orphaned goroutines
- Turn already complete

**When to read:** Error handling, production debugging

---

## Flow Summary

### Creating a Turn (User Sends Message)

1. **Client** -> POST `/api/threads/:id/turns` with user message
2. **StreamingService** creates user turn + assistant turn (`status="streaming"`)
3. **StreamingService** creates `StreamExecutor` + `mstream.Stream` and registers it in the `mstream.Registry`
4. **StreamExecutor** calls LLM provider (`StreamResponse`) via `meridian-llm-go`
5. **Provider** streams events (`Delta`, `Block`, `Metadata`)
6. **StreamExecutor**:
   - Sends `TurnBlockDelta` events into `mstream.Stream` for SSE
   - Persists complete `TurnBlock`s to PostgreSQL
7. **Client** receives real-time updates via SSE (`turn_start`, `block_start`, `block_delta`, `block_stop`, `turn_complete`)

### Streaming Events (SSE)

1. **Client** -> GET `/api/turns/:id/stream`
2. **SSE Handler** gets `mstream.Stream` from the registry and replays catchup events (if reconnecting)
3. **StreamExecutor** pushes new events into `mstream.Stream`
4. **mstream.Stream** broadcasts SSE events (`block_*`, `turn_*`) to all connected clients
5. **StreamExecutor** sends `turn_complete` / `turn_error` when streaming finishes
6. **Connection** closes gracefully

---

## Implementation Files

**Service Layer:**
- `internal/service/llm/streaming/service.go` - StreamingService (orchestration)
- `internal/service/llm/streaming/mstream_adapter.go` - StreamExecutor + mstream integration
- `internal/service/llm/streaming/catchup.go` - DB-backed catchup logic
- `internal/service/llm/streaming/debug.go` - Debug helpers
- `internal/service/llm/streaming/response_generator.go` - LLM coordination

**Handlers:**
- `internal/handler/thread.go:346-350` - StreamTurn endpoint
- `internal/handler/sse_handler.go` - SSE connection handling

**Models:**
- `internal/domain/models/llm/turn_block_delta.go` - Delta events
- `internal/domain/models/llm/turn_block.go` - Persisted blocks

---

## Quick Reference

### SSE Event Types

- `turn_start` - Turn begins
- `block_start` - New block starts
- `block_delta` - Content delta
- `block_stop` - Block complete
- `block_catchup` - Reconnection catchup
- `turn_complete` - Turn finished
- `turn_error` - Error occurred

### Status Lifecycle

```
pending -> streaming -> complete
        ↓           ↓
    cancelled    error
```

---

## Related Documentation

- [Service Layer Architecture](../../backend/architecture/service-layer.md) - 3-service split
- [Thread Domain Model](../../backend/thread/overview.md) - Turn and block concepts
- [LLM Providers](../../backend/thread/llm-providers.md) - Provider abstraction
- [Token Finalization](../tokens/README.md) - Token finalization strategy chain
- [API Contracts](../../backend/api/contracts.md) - HTTP endpoints
