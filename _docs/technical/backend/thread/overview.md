---
detail: minimal
audience: developer
---

# Thread System Overview

Multi-turn LLM conversations with branching support, streaming responses, and unified JSONB turn blocks.

## Tree Structure

Conversations form a tree via `prev_turn_id` self-referencing, enabling branching:

```mermaid
graph TD
    T1["Turn 1: user"] --> T2["Turn 2: assistant"]
    T2 --> T3a["Turn 3a: user"]
    T2 -.branch.-> T3b["Turn 3b: user"]
    T3a --> T4a["Turn 4a: assistant"]
    T3b --> T4b["Turn 4b: assistant"]
```

- Root turns have `prev_turn_id IS NULL`
- Multiple turns referencing the same parent = branching
- Deleting a turn cascades to the entire downstream branch

## Service Architecture

Three focused services (SRP compliance). See [service-layer.md](../architecture/service-layer.md) for rationale.

```mermaid
graph TD
    Handler["ThreadHandler"] --> TS["ThreadService\nThread CRUD"]
    Handler --> THS["ThreadHistoryService\nHistory & Navigation"]
    Handler --> SS["StreamingService\nTurn Creation & Streaming"]
```

| Service | Responsibility | Interface |
|---------|---------------|-----------|
| ThreadService | Thread session CRUD | `domain/services/llm/thread.go` |
| ThreadHistoryService | Turn path, siblings, tree, pagination, token usage | `domain/services/llm/thread_history.go` |
| StreamingService | Turn creation, streaming orchestration, interjections | `domain/services/llm/streaming.go` |

## API Routes

Routes are defined in `cmd/server/main.go`. Handler: `internal/handler/thread.go`.

**Thread CRUD:** `POST/GET/PATCH/DELETE /api/threads`, `PATCH .../last-viewed-turn`

**Turn & Pagination:** `POST /api/turns`, `GET /api/threads/{id}/turns`, `GET /api/turns/{id}/path`, `GET /api/turns/{id}/siblings`

**Streaming:** `GET /api/turns/{id}/stream` (SSE), `GET .../blocks`, `GET .../token-usage`, `POST .../interrupt`

**Interjections:** `POST/GET/DELETE /api/turns/{id}/interjection`

**Debug (dev only):** `POST/GET /debug/api/threads/{id}/turns`, `GET .../tree`, `POST .../llm-request`

## Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending: Create turn
    pending --> streaming: LLM starts
    streaming --> waiting_subagents: Tool use detected
    streaming --> complete: No tools
    waiting_subagents --> streaming: Tool results ready
    streaming --> complete: All done
    streaming --> error: LLM error
    pending --> cancelled: User cancels
    streaming --> cancelled: User interrupts
    error --> [*]
    complete --> [*]
    cancelled --> [*]
```

## Streaming Flow

`POST /api/turns` triggers async LLM generation. The response includes a `stream_url` for SSE connection.

```mermaid
sequenceDiagram
    participant Client
    participant Handler
    participant StreamingService
    participant Provider

    Client->>Handler: POST /api/turns
    Handler->>StreamingService: CreateTurn
    StreamingService->>StreamingService: Create user + pending assistant turn
    StreamingService-->>Handler: user_turn, assistant_turn, stream_url
    Handler-->>Client: 201 Created

    Client->>Handler: GET /api/turns/{id}/stream
    Note over StreamingService,Provider: Background goroutine
    StreamingService->>Provider: StreamResponse
    Provider-->>StreamingService: AG-UI events
    StreamingService-->>Client: SSE events
```

Key features: AG-UI protocol events, partial block persistence on interruption, soft/hard cancel, reconnection via `GET /api/turns/{id}/blocks`. See `_docs/technical/llm/streaming/README.md`.

## Interjections

Users can submit messages while the assistant is streaming. Content is buffered and injected at the next safe boundary (after tool execution or at stream completion). If the turn is no longer streaming, a new follow-up turn is created instead.

Modes: `append` (add to existing) or `replace` (overwrite existing).

## References

- [Turn Blocks](turn-blocks.md) -- JSONB schemas
- [LLM Providers](llm-providers.md) -- Provider architecture
- [Pagination](pagination.md) -- Pagination implementation
- Domain models: `internal/domain/models/llm/`
- Handler: `internal/handler/thread.go`
