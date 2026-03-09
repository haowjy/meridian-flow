---
detail: minimal
audience: developer
---

# Service Layer Architecture: LLM Services

The LLM service layer splits a former monolithic ThreadService (1500+ lines) into 3 focused services following SOLID principles.

## Service Overview

```mermaid
graph TB
    Handler["ThreadHandler"]

    ThreadSvc["ThreadService\nCRUD Operations"]
    HistorySvc["ThreadHistoryService\nHistory & Navigation"]
    StreamSvc["StreamingService\nTurn Creation & Streaming"]

    ThreadRepo[("ThreadRepository")]
    TurnRepo[("TurnRepository\nReader + Writer + Navigator")]
    CapRegistry["CapabilityRegistry"]

    Handler --> ThreadSvc
    Handler --> HistorySvc
    Handler --> StreamSvc

    ThreadSvc --> ThreadRepo
    HistorySvc --> TurnRepo
    HistorySvc --> CapRegistry
    StreamSvc --> TurnRepo
    StreamSvc --> Generator["ResponseGenerator\nLLM Orchestration"]
    StreamSvc --> Registry["StreamRegistry\nmstream"]
```

## The Three Services

| Service | Responsibility | Size | Key Dependencies |
|---------|---------------|------|-----------------|
| **ThreadService** | Thread session CRUD | ~150 lines | ThreadRepository, ProjectRepository |
| **ThreadHistoryService** | Turn path, siblings, tree, pagination, token usage | ~210 lines | TurnReader, TurnNavigator, CapabilityRegistry |
| **StreamingService** | Turn creation, streaming, tool execution, interjections | 20+ files | TurnWriter, TurnReader, TurnNavigator, ProviderGetter, mstream.Registry, many more |

See `internal/service/llm/setup.go` for full dependency wiring.

**Why separate?** Each service has a single reason to change. ThreadService can be used standalone for thread lists. HistoryService is read-optimized with batch block loading. StreamingService isolates complex orchestration (background goroutines, SSE broadcasting, tool execution loops).

## Key Flows

### User Sends Message

```mermaid
sequenceDiagram
    participant Client
    participant Handler as ThreadHandler
    participant Stream as StreamingService
    participant Turn as TurnRepository
    participant Registry as StreamRegistry
    participant Executor as StreamExecutor
    participant Provider as LLM Provider

    Client->>Handler: POST /api/turns
    Handler->>Stream: CreateTurn

    Note over Stream: Resolve thread, cold-start if needed
    Stream->>Turn: Create user + assistant turns
    Stream->>Registry: Register mstream.Stream
    Stream->>Executor: Start in goroutine

    Stream-->>Handler: user_turn, assistant_turn, stream_url
    Handler-->>Client: 201 Created

    Note over Executor,Provider: Background goroutine

    loop Stream events + tool rounds
        Executor->>Provider: StreamResponse
        Provider-->>Executor: StreamEvents
        Executor->>Registry: Fan out via mstream
        Registry-->>Client: SSE events
    end

    Executor->>Turn: Persist blocks + finalize
```

### User Views Thread History

```mermaid
sequenceDiagram
    participant Client
    participant Handler as ThreadHandler
    participant History as ThreadHistoryService
    participant TurnNav as TurnNavigator

    Client->>Handler: GET /api/threads/:id/turns
    Handler->>History: GetPaginatedTurns
    History->>TurnNav: GetPaginatedTurns
    TurnNav-->>History: turns + blocks + pagination flags
    History-->>Handler: PaginatedTurnsResponse
    Handler-->>Client: 200 OK
```

## SOLID Compliance

**SRP**: Each service has one reason to change. ThreadService knows nothing about streaming; HistoryService knows nothing about LLM calls.

**ISP**: Three focused service interfaces instead of one fat interface. TurnRepository is consumed via 3 narrow interfaces: `TurnReader`, `TurnWriter`, `TurnNavigator`.

**DIP**: Services depend on repository/provider interfaces, not implementations. See the dependency diagram above.

## Authorization Pattern

All services receive a `ResourceAuthorizer`. Authorization happens at the service layer (not handler), enforcing ownership chain: turn -> thread -> project -> user.

## References

- Domain interfaces: `internal/domain/services/llm/thread.go`, `thread_history.go`, `streaming.go`
- Implementations: `internal/service/llm/thread/`, `thread_history/`, `streaming/`
- Setup helper: `internal/service/llm/setup.go`
- [Architecture Overview](overview.md)
- [Tool System Architecture](../tools/architecture.md)
