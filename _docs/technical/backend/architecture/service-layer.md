---
detail: comprehensive
audience: developer
---

# Service Layer Architecture: LLM Services

The LLM service layer is organized into 3 focused services following SOLID principles, replacing a monolithic ThreadService that previously contained 1500+ lines.

## Overview

```mermaid
graph TB
    Handler[Handler Layer<br/>thread.go]

    ThreadSvc[ThreadService<br/>CRUD Operations]
    ConvoSvc[ConversationService<br/>History & Navigation]
    StreamSvc[StreamingService<br/>Turn Creation & Streaming]

    ThreadRepo[(ThreadRepository)]
    TurnRepo[(TurnRepository)]
    ProjectRepo[(ProjectRepository)]

    Executor[StreamExecutor<br/>mstream Stream Worker]
    Generator[ResponseGenerator<br/>LLM Orchestration]
    Registry[StreamRegistry<br/>Active Streams (mstream)]

    Handler --> ThreadSvc
    Handler --> ConvoSvc
    Handler --> StreamSvc

    ThreadSvc --> ThreadRepo
    ThreadSvc --> ProjectRepo

    ConvoSvc --> ThreadRepo
    ConvoSvc --> TurnRepo

    StreamSvc --> TurnRepo
    StreamSvc --> Generator
    StreamSvc --> Registry

    Registry --> Executor
    Generator --> Provider[LLM Provider]

```

## The Three Services

### 1. ThreadService (`internal/service/llm/thread/service.go`)

**Single Responsibility:** Thread session management (CRUD only)

**Methods:**
- `CreateThread(ctx, req) (*Thread, error)` - Create new thread session
- `GetThread(ctx, threadID, userID) (*Thread, error)` - Retrieve thread by ID
- `ListThreads(ctx, projectID, userID) ([]Thread, error)` - List user's threads
- `UpdateThread(ctx, threadID, userID, req) (*Thread, error)` - Update thread title
- `DeleteThread(ctx, threadID, userID) (*Thread, error)` - Soft-delete thread

**Dependencies:**
- `ThreadRepository` - Thread data access
- `ProjectRepository` - Verify project exists

**Why Separate?**
- **Single Responsibility**: Only manages thread sessions
- **No knowledge** of turns, streaming, or LLM interactions
- **Independent use**: Can be used standalone for thread list UI
- **Clear boundaries**: Thread lifecycle is distinct from conversation flow

**File:** `internal/service/llm/thread/service.go` (~150 lines)

---

### 2. ConversationService (`internal/service/llm/conversation/service.go`)

**Single Responsibility:** Conversation history and navigation

**Methods:**
- `GetTurnPath(ctx, turnID) ([]Turn, error)` - Get path from root to turn
- `GetTurnSiblings(ctx, turnID) ([]Turn, error)` - Get all siblings (branching)
- `GetThreadTree(ctx, threadID, userID) (*ThreadTree, error)` - Get lightweight tree structure
- `GetPaginatedTurns(ctx, threadID, userID, fromTurnID, limit, direction) (*PaginatedTurnsResponse, error)` - Paginated turn loading

**Dependencies:**
- `ThreadRepository` - Verify thread ownership
- `TurnRepository` - Turn navigation queries

**Why Separate?**
- **Single Responsibility**: Only handles navigation and history retrieval
- **No knowledge** of LLM calls, streaming, or turn creation
- **Optimized for reads**: Specialized recursive CTEs, N+1 query elimination
- **Pagination expertise**: Complex direction-based queries isolated here

**File:** `internal/service/llm/conversation/service.go` (~90 lines)

---

### 3. StreamingService (`internal/service/llm/streaming/service.go`)

**Single Responsibility:** Turn creation and streaming orchestration

**Methods:**
- `CreateTurn(ctx, req) (*CreateTurnResponse, error)` - Create user + assistant turns, initiate streaming
- `CreateAssistantTurnDebug(ctx, ...) (*Turn, error)` - Debug-only: Manual assistant turn creation

**Dependencies:**
- `TurnRepository` - Turn persistence
- `ThreadValidator` - Validate thread exists and ownership
- `ResponseGenerator` - LLM response orchestration
- `*mstream.Registry` - Manage active streaming streams (SSE fan-out + catchup)
- `TransactionManager` - Atomic user+assistant turn creation

**Why Separate?**
- **Single Responsibility**: Only handles turn creation and streaming coordination
- **Complex orchestration**: Background goroutine management, SSE broadcasting
- **Isolated complexity**: Streaming logic doesn't pollute CRUD or navigation code
- **Testability**: Mock executor registry for testing without real streaming

**File:** `internal/service/llm/streaming/service.go` (~280 lines)

**Supporting Components:**
- `mstream_adapter.go` - StreamExecutor (adapts meridian-llm-go -> TurnBlockDelta/TurnBlock + mstream.Stream)
- `catchup.go` - DB-backed catchup for reconnection
- `debug.go` - Debug helpers for internal streaming flows
- `response_generator.go` - LLM provider orchestration

---

## Service Interactions

### Flow: User Sends Message

```mermaid
sequenceDiagram
    participant Client
    participant Handler as ThreadHandler
    participant Stream as StreamingService
    participant Turn as TurnRepository
    participant Registry as StreamRegistry
    participant Executor as StreamExecutor
    participant Generator as ResponseGenerator
    participant Provider as LLM Provider

    Client->>Handler: POST /api/threads/:id/turns
    Handler->>Stream: CreateTurn(req)

    Stream->>Turn: CreateTurn(user turn)
    Turn-->>Stream: User turn created

    Stream->>Turn: CreateTurn(assistant turn, status="streaming")
    Turn-->>Stream: Assistant turn created

    Stream->>Registry: Register new mstream.Stream(turnID)
    Stream->>Executor: NewStreamExecutor(turnID, provider, turnRepo, logger)
    Stream->>Executor: Start(generateReq) in goroutine

    Stream-->>Handler: {user_turn, assistant_turn, stream_url}
    Handler-->>Client: 201 Created

    Note over Executor,Provider: Background goroutine (mstream WorkFunc)

    Executor->>Provider: StreamResponse(generateReq)

    loop Stream events
        Provider-->>Executor: StreamEvent{Delta | Block | Metadata}
        Executor->>Registry: Send events via mstream.Stream
        Registry-->>Client: SSE events (block_start, block_delta, block_stop, turn_complete)
    end

    Provider-->>Executor: StreamEvent{Metadata}
    Executor->>Turn: UpdateTurnStatus("complete")
    Executor->>Registry: Send turn_complete
```

### Flow: User Views Thread History

```mermaid
sequenceDiagram
    participant Client
    participant Handler as ThreadHandler
    participant Convo as ConversationService
    participant Turn as TurnRepository

    Client->>Handler: GET /api/threads/:id/turns?direction=both&limit=100
    Handler->>Convo: GetPaginatedTurns(threadID, ...)

    Convo->>Turn: GetPaginatedTurns(fromTurnID, direction, limit)
    Turn-->>Convo: {turns, blocks, has_more_before, has_more_after}

    Convo-->>Handler: PaginatedTurnsResponse
    Handler-->>Client: 200 OK + turns with blocks
```

---

## SOLID Principles Compliance

### Single Responsibility Principle (SRP) ✅

**Before (Monolithic ThreadService):**
- Thread CRUD
- Turn operations
- Conversation navigation
- Streaming coordination
- LLM integration
- **Result:** 1500+ lines, multiple reasons to change

**After (3 Services):**
- `ThreadService`: Thread CRUD only (150 lines)
- `ConversationService`: Navigation only (90 lines)
- `StreamingService`: Streaming only (280 lines)
- **Result:** Each service has one reason to change

---

### Open/Closed Principle (OCP) ✅

**Extension without modification:**
```go
// Adding new LLM provider (no service modification required)
newProvider := openai.NewProvider(apiKey, logger)
providerRegistry.RegisterProvider(newProvider)
```

**New features:**
- Add new thread metadata field -> Only update ThreadService
- Add new navigation query -> Only update ConversationService
- Add new streaming event type -> Only update StreamingService

---

### Liskov Substitution Principle (LSP) ✅

**All services implement domain interfaces:**
```go
// Domain interface (internal/domain/services/llm/thread.go)
type ThreadService interface {
    CreateThread(ctx context.Context, req *CreateThreadRequest) (*Thread, error)
    // ...
}

// Implementation (internal/service/llm/thread/service.go)
type Service struct {
    threadRepo  llmRepo.ThreadRepository
    projectRepo docsysRepo.ProjectRepository
    logger      *slog.Logger
}

func (s *Service) CreateThread(...) (*Thread, error) {
    // Implementation
}
```

**Mock for testing:**
```go
type MockThreadService struct{}

func (m *MockThreadService) CreateThread(...) (*Thread, error) {
    return &Thread{ID: "test-id"}, nil
}

// Can substitute real service with mock
handler := NewThreadHandler(mockThreadService, ..., logger)
```

---

### Interface Segregation Principle (ISP) ✅

**Before:** Fat interface with 11 methods
```go
// Old monolithic interface
type ThreadService interface {
    CreateThread(...)
    GetThread(...)
    ListThreads(...)
    UpdateThread(...)
    DeleteThread(...)
    CreateTurn(...)
    GetTurnPath(...)
    GetTurnSiblings(...)
    GetThreadTree(...)
    GetPaginatedTurns(...)
    // ... even more methods
}
```

**After:** 3 focused interfaces
```go
// Thread CRUD (5 methods)
type ThreadService interface {
    CreateThread(...)
    GetThread(...)
    ListThreads(...)
    UpdateThread(...)
    DeleteThread(...)
}

// Conversation navigation (4 methods)
type ConversationService interface {
    GetTurnPath(...)
    GetTurnSiblings(...)
    GetThreadTree(...)
    GetPaginatedTurns(...)
}

// Streaming (2 methods)
type StreamingService interface {
    CreateTurn(...)
    CreateAssistantTurnDebug(...)
}
```

**Benefits:**
- Handlers only depend on interfaces they use
- Testing mocks are simpler (fewer methods to implement)
- Changes to one interface don't affect unrelated code

---

### Dependency Inversion Principle (DIP) ✅

**Services depend on abstractions:**
```mermaid
graph TB
    Service[ThreadService<br/>implementation]
    Interface[ThreadRepository<br/>interface]
    Postgres[PostgresThreadRepository<br/>implementation]

    Service -.depends on.-> Interface
    Postgres -.implements.-> Interface

```

**Example:**
```go
// Service depends on interface (domain)
type Service struct {
    threadRepo llmRepo.ThreadRepository  // Interface!
}

// Repository implements interface
type PostgresThreadRepository struct {
    pool *pgxpool.Pool
}

func (r *PostgresThreadRepository) Create(...) error {
    // PostgreSQL-specific implementation
}
```

**Benefits:**
- Swap PostgreSQL for MongoDB without changing service
- Mock repository for unit tests
- Service doesn't know about SQL, pgx, or PostgreSQL

---

## Authorization Pattern

All services receive a `ResourceAuthorizer` dependency for ownership-based access control:

```go
type DocumentService struct {
    docRepo    docsysRepo.DocumentRepository
    authorizer services.ResourceAuthorizer  // Injected dependency
    logger     *slog.Logger
}

func (s *DocumentService) GetDocument(ctx context.Context, userID, docID string) (*Document, error) {
    // Auth check first
    if err := s.authorizer.CanAccessDocument(ctx, userID, docID); err != nil {
        return nil, err
    }
    // Then fetch
    return s.docRepo.GetByIDOnly(ctx, docID)
}
```

**Key Points:**
- Authorization at service layer (not handler)
- Consistent across all entry points
- Uses `GetByIDOnly` pattern after auth (no projectID needed)
- See [authorization.md](../auth/authorization.md) for details

---

## File Structure

```
internal/
├── domain/
│   ├── services/llm/
│   │   ├── thread.go               # ThreadService interface
│   │   ├── conversation.go         # ConversationService interface
│   │   ├── streaming.go            # StreamingService interface
│   │   └── provider.go             # LLMProvider interface
│   │
│   └── repositories/llm/
│       ├── thread.go               # ThreadRepository interface
│       └── turn.go                 # TurnRepository interface
│
├── service/llm/
│   ├── thread/
│   │   └── service.go              # ThreadService implementation
│   │
│   ├── conversation/
│   │   └── service.go              # ConversationService implementation
│   │
│   ├── streaming/
│   │   ├── service.go              # StreamingService implementation
│   │   ├── mstream_adapter.go      # StreamExecutor + mstream integration
│   │   ├── catchup.go              # DB-backed catchup logic
│   │   ├── debug.go                # Streaming debug helpers
│   │   └── response_generator.go   # LLM orchestration
│   │
│   ├── providers/
│   │   ├── anthropic/              # Anthropic Claude provider
│   │   │   ├── client.go
│   │   │   ├── adapter.go
│   │   │   └── config.go
│   │   └── lorem/                  # Mock provider (dev/test)
│   │
│   ├── registry.go                 # Provider registry
│   ├── validation.go               # ThreadValidator
│   └── setup.go                    # Dependency injection helper
│
├── handler/
│   ├── thread.go                   # ThreadHandler (uses all 3 services)
│   ├── thread_debug.go             # Debug endpoints
│   └── sse_handler.go              # SSE streaming handler
│
└── repository/postgres/llm/
    ├── thread.go                   # PostgresThreadRepository
    └── turn.go                     # PostgresTurnRepository
```

---

## Dependency Injection

### Setup Helper (`internal/service/llm/setup.go`)

```go
// Services struct holds all 3 services
type Services struct {
    Thread       llmSvc.ThreadService
    Conversation llmSvc.ConversationService
    Streaming    llmSvc.StreamingService
}

// SetupServices initializes all LLM services with proper dependency injection
func SetupServices(
    threadRepo llmRepo.ThreadRepository,
    turnRepo llmRepo.TurnRepository,
    projectRepo docsysRepo.ProjectRepository,
    providerRegistry *ProviderRegistry,
    cfg *config.Config,
    txManager repositories.TransactionManager,
    logger *slog.Logger,
) (*Services, *mstream.Registry, error) {
    // Create shared validator
    validator := NewThreadValidator(threadRepo)

    // Create mstream registry (for SSE streaming)
    streamRegistry := mstream.NewRegistry()

    // Start cleanup goroutine for old streams
    go streamRegistry.StartCleanup(context.Background())

    // Create response generator
    responseGenerator := streaming.NewResponseGenerator(providerRegistry, turnRepo, logger)

    // Create thread service (CRUD only)
    threadService := thread.NewService(
        threadRepo,
        projectRepo,
        logger,
    )

    // Create conversation service (history/navigation)
    conversationService := conversation.NewService(
        threadRepo,
        turnRepo,
    )

    // Create streaming service (turn creation/orchestration)
    streamingService := streaming.NewService(
        turnRepo,
        validator,
        responseGenerator,
        streamRegistry,
        cfg,
        txManager,
        logger,
    )

    return &Services{
        Thread:       threadService,
        Conversation: conversationService,
        Streaming:    streamingService,
    }, streamRegistry, nil
}
```

### Usage in main.go (`cmd/server/main.go`)

```go
// Setup LLM services
llmServices, streamRegistry, err := serviceLLM.SetupServices(
    threadRepo,
    turnRepo,
    projectRepo,
    providerRegistry,
    cfg,
    txManager,
    logger,
)
if err != nil {
    log.Fatalf("Failed to setup LLM services: %v", err)
}

// Create handler with all 3 services
// Create SSE handler
sseHandler := handler.NewSSEHandler(
    streamRegistry,
    logger,
)
```

---

## Migration: Before vs After

### Before: Monolithic ThreadService

**File:** `internal/service/llm/thread.go` (1500+ lines, deleted)

**Problems:**
- 11+ methods mixing different responsibilities
- Hard to test (large surface area)
- Difficult to navigate
- Changes to streaming affect thread CRUD
- Unclear dependencies

**Structure:**
```go
type ThreadService struct {
    threadRepo      ThreadRepository
    turnRepo        TurnRepository
    projectRepo     ProjectRepository
    validator       ThreadValidator
    providerRegistry *ProviderRegistry
    executorRegistry *ExecutorRegistry
    responseGenerator *ResponseGenerator
    txManager        TransactionManager
    config           *Config
    logger           *slog.Logger
}

// Thread CRUD
func (s *ThreadService) CreateThread(...)
func (s *ThreadService) GetThread(...)
func (s *ThreadService) ListThreads(...)
func (s *ThreadService) UpdateThread(...)
func (s *ThreadService) DeleteThread(...)

// Turn operations
func (s *ThreadService) CreateTurn(...)

// Navigation
func (s *ThreadService) GetTurnPath(...)
func (s *ThreadService) GetTurnSiblings(...)
func (s *ThreadService) GetThreadTree(...)
func (s *ThreadService) GetPaginatedTurns(...)

// ... more methods
```

---

### After: 3 Focused Services

**Total Lines:** ~520 (vs 1500+)

**ThreadService** (`thread/service.go` - 150 lines)
```go
type Service struct {
    threadRepo  llmRepo.ThreadRepository
    projectRepo docsysRepo.ProjectRepository
    logger      *slog.Logger
}

func (s *Service) CreateThread(...)
func (s *Service) GetThread(...)
func (s *Service) ListThreads(...)
func (s *Service) UpdateThread(...)
func (s *Service) DeleteThread(...)
```

**ConversationService** (`conversation/service.go` - 90 lines)
```go
type Service struct {
    threadRepo llmRepo.ThreadRepository
    turnRepo llmRepo.TurnRepository
}

func (s *Service) GetTurnPath(...)
func (s *Service) GetTurnSiblings(...)
func (s *Service) GetThreadTree(...)
func (s *Service) GetPaginatedTurns(...)
```

**StreamingService** (`streaming/service.go` - 280 lines)
```go
type Service struct {
    turnRepo          llmRepo.TurnRepository
    validator         ThreadValidator
    responseGenerator *ResponseGenerator
    registry          *mstream.Registry
    config            *config.Config
    txManager         repositories.TransactionManager
    logger            *slog.Logger
}

func (s *Service) CreateTurn(...)
func (s *Service) CreateAssistantTurnDebug(...)
```

---

## Benefits of Split Architecture

### 1. Easier to Test

**Before:** Mock 10+ dependencies for any test
```go
// Testing thread CRUD required mocking streaming components too
mockProviderRegistry := &MockProviderRegistry{}
mockExecutorRegistry := &MockExecutorRegistry{}
mockResponseGenerator := &MockResponseGenerator{}
// ... and 7 more dependencies
```

**After:** Mock only what you need
```go
// Testing thread CRUD
mockThreadRepo := &MockThreadRepository{}
mockProjectRepo := &MockProjectRepository{}
threadService := thread.NewService(mockThreadRepo, mockProjectRepo, logger)
// Only 3 dependencies!
```

---

### 2. Clear Responsibilities

Each service answers one question:
- **ThreadService:** "How do I manage thread sessions?"
- **ConversationService:** "How do I navigate conversation history?"
- **StreamingService:** "How do I create turns and stream responses?"

---

### 3. Better Performance

**ConversationService optimization:**
- Specialized recursive CTEs for path finding
- Leaf node discovery optimizations
- N+1 query elimination in pagination
- No overhead from unused streaming infrastructure

**Before:** All thread operations carried streaming overhead
**After:** Only streaming operations use streaming infrastructure

---

### 4. Independent Development

**Teams can work in parallel:**
- Team A: Add thread metadata features (ThreadService)
- Team B: Optimize pagination (ConversationService)
- Team C: Implement tool execution (StreamingService)

**No merge conflicts, no stepping on toes.**

---

### 5. Easier to Understand

**New developer onboarding:**
- Want to understand thread CRUD? Read 150 lines (thread/service.go)
- Want to understand pagination? Read 90 lines (conversation/service.go)
- Want to understand streaming? Read 280 lines (streaming/service.go)

**Before:** Read 1500+ lines to understand anything

---

## Testing Strategy

### Unit Testing Services

**ThreadService tests:**
```go
func TestThreadService_CreateThread(t *testing.T) {
    mockThreadRepo := &MockThreadRepository{}
    mockProjectRepo := &MockProjectRepository{}
    service := thread.NewService(mockThreadRepo, mockProjectRepo, logger)

    // Test only thread creation logic
    thread, err := service.CreateThread(ctx, &req)
    // ...
}
```

**ConversationService tests:**
```go
func TestConversationService_GetPaginatedTurns(t *testing.T) {
    mockThreadRepo := &MockThreadRepository{}
    mockTurnRepo := &MockTurnRepository{}
    service := conversation.NewService(mockThreadRepo, mockTurnRepo)

    // Test only pagination logic
    response, err := service.GetPaginatedTurns(ctx, ...)
    // ...
}
```

**StreamingService tests:**
```go
func TestStreamingService_CreateTurn(t *testing.T) {
    mockTurnRepo := &MockTurnRepository{}
    mockValidator := &MockThreadValidator{}
    mockGenerator := &MockResponseGenerator{}
    mockRegistry := &MockExecutorRegistry{}

    service := streaming.NewService(
        mockTurnRepo,
        mockValidator,
        mockGenerator,
        mockRegistry,
        cfg,
        txManager,
        logger,
    )

    // Test turn creation and streaming initiation
    response, err := service.CreateTurn(ctx, &req)
    // ...
}
```

---

### Integration Testing

**Test service interactions:**
```go
func TestThreadFlow_CreateAndStream(t *testing.T) {
    // Use real services with test database
    threadService := thread.NewService(threadRepo, projectRepo, logger)
    streamingService := streaming.NewService(...)

    // Create thread
    thread, err := threadService.CreateThread(ctx, &req)
    require.NoError(t, err)

    // Create turn (triggers streaming)
    response, err := streamingService.CreateTurn(ctx, &turnReq)
    require.NoError(t, err)

    // Verify turn was created
    assert.NotEmpty(t, response.AssistantTurn.ID)
}
```

---

## Common Patterns

### Error Handling

All services use domain errors:
```go
// Service layer
if !exists {
    return nil, fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
}

// Handler layer maps to HTTP
if errors.Is(err, domain.ErrNotFound) {
    return c.Status(404).JSON(fiber.Map{"error": err.Error()})
}
```

---

### Context Cancellation

All services respect context cancellation:
```go
func (s *Service) CreateThread(ctx context.Context, req *CreateThreadRequest) (*Thread, error) {
    // Check context before expensive operations
    if err := ctx.Err(); err != nil {
        return nil, err
    }

    // Repository calls pass context through
    if err := s.threadRepo.Create(ctx, thread); err != nil {
        return nil, err
    }

    return thread, nil
}
```

---

### Transaction Management

StreamingService uses transactions for atomic operations:
```go
// CreateTurn creates user turn + assistant turn atomically
func (s *Service) CreateTurn(ctx context.Context, req *CreateTurnRequest) (*CreateTurnResponse, error) {
    tx, err := s.txManager.BeginTx(ctx)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback(ctx)

    // Create user turn
    if err := s.turnRepo.CreateTurn(tx.Context(), userTurn); err != nil {
        return nil, err
    }

    // Create assistant turn
    if err := s.turnRepo.CreateTurn(tx.Context(), assistantTurn); err != nil {
        return nil, err
    }

    if err := tx.Commit(ctx); err != nil {
        return nil, err
    }

    return response, nil
}
```

---

## References

**Domain Interfaces:**
- `internal/domain/services/llm/thread.go`
- `internal/domain/services/llm/conversation.go`
- `internal/domain/services/llm/streaming.go`

**Implementations:**
- `internal/service/llm/thread/service.go`
- `internal/service/llm/conversation/service.go`
- `internal/service/llm/streaming/service.go`

**Supporting Components:**
- `internal/service/llm/streaming/executor.go`
- `internal/service/llm/streaming/registry.go`
- `internal/service/llm/streaming/accumulator.go`
- `internal/service/llm/streaming/response_generator.go`

**Setup:**
- `internal/service/llm/setup.go` - Dependency injection
- `cmd/server/main.go:85-128` - Service wiring

**Handlers:**
- `internal/handler/thread.go` - ThreadHandler using all 3 services
- `internal/handler/thread_debug.go` - Debug endpoints

**Related Documentation:**
- [Clean Architecture Overview](overview.md)
- [Streaming Architecture](streaming-architecture.md)
- [Thread Domain Model](../thread/overview.md)
- [Pagination Guide](../thread/pagination.md)
