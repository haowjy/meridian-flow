# Go Best Practices Research (2025)

**Date:** October 31, 2025
**Purpose:** Research findings on modern Go architecture patterns and recommended packages for Meridian backend refactoring

---

## Table of Contents

1. [Clean Architecture Patterns](#clean-architecture-patterns)
2. [Handler-Service-Repository Pattern](#handler-service-repository-pattern)
3. [Recommended Packages](#recommended-packages)
4. [Transaction Patterns](#transaction-patterns)
5. [References](#references)

---

## Clean Architecture Patterns

### Overview

Clean Architecture in Go separates code into layers with clear dependency rules: inner layers (domain/business logic) don't depend on outer layers (infrastructure/UI).

### Standard Layer Structure

Based on community consensus (Three Dots Labs, golang-standards, DDD practitioners):

```
Handlers (HTTP/API)
    ↓ depends on
Services (Business Logic / Use Cases)
    ↓ depends on
Repositories (Data Access Interfaces)
    ↓ implemented by
Database/Infrastructure
```

### Key Principles

1. **Dependency Inversion**: High-level modules (services) depend on abstractions (interfaces), not concrete implementations
2. **Single Responsibility**: Each layer has one job - handlers handle HTTP, services handle business logic, repositories handle data access
3. **Interface Segregation**: Define repository interfaces in domain layer, implement in infrastructure layer
4. **Testability**: Each layer can be unit tested in isolation with mocked dependencies

### Common Project Structure

```
internal/
├── domain/              # Core domain (no external dependencies)
│   ├── models/          # Entities (Document, Folder, Project)
│   ├── repositories/    # Repository interfaces
│   ├── services/        # Service interfaces (optional, for mocking)
│   └── errors.go        # Domain errors
├── service/             # Business logic implementations
│   ├── document.go
│   ├── folder.go
│   └── tree.go
├── repository/          # Data access implementations
│   └── postgres/
│       ├── document.go
│       ├── folder.go
│       └── transaction.go
├── handler/             # HTTP layer (Fiber/Gin/Chi)
│   ├── document.go
│   ├── folder.go
│   └── tree.go
└── middleware/
```

### When to Use Full Clean Architecture

**Use for:**
- Multi-developer teams
- Long-lived applications
- Complex business logic
- Apps that need different interfaces (HTTP, gRPC, CLI)
- Apps requiring extensive testing

**Skip for:**
- Simple CRUD apps
- Proof-of-concepts
- Single-file scripts
- Apps with minimal business logic

**Meridian's case:** Clean architecture is appropriate due to:
- Future LLM streaming features (complex orchestration)
- Vector search integration (multiple data sources)
- Need for extensive testing
- Growing codebase

---

## Handler-Service-Repository Pattern

### Handler Layer (HTTP/API Interface)

**Responsibilities:**
- Parse HTTP requests
- Extract and validate input
- Call service layer
- Map service errors to HTTP status codes
- Format and return HTTP responses

**Should NOT:**
- Contain business logic
- Access database directly
- Perform complex calculations
- Handle transactions

**Best Practices:**
- Keep handlers thin (<50 lines)
- Use struct-based handlers for dependency injection
- Extract context values (userID, projectID) in middleware
- Return consistent error responses

**Example:**
```go
type DocumentHandler struct {
    docService domain.DocumentService
    logger     *slog.Logger
}

func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
    var req CreateDocumentRequest
    if err := c.BodyParser(&req); err != nil {
        return fiber.NewError(fiber.StatusBadRequest, "Invalid request")
    }

    doc, err := h.docService.CreateDocument(c.Context(), &req)
    if err != nil {
        return mapErrorToHTTP(err)
    }

    return c.Status(fiber.StatusCreated).JSON(doc)
}
```

### Service Layer (Business Logic)

**Responsibilities:**
- Orchestrate business operations
- Validate business rules
- Coordinate multiple repositories
- Handle transactions
- Transform data between layers

**Should NOT:**
- Know about HTTP (no fiber.Ctx)
- Know about SQL (no SQL queries)
- Handle request/response formatting

**Best Practices:**
- Services depend on repository interfaces, not concrete implementations
- Use context.Context for cancellation and timeout propagation
- Return domain errors, let handlers map to HTTP status
- Keep services focused (one service per aggregate/entity)

**Example:**
```go
type DocumentService struct {
    docRepo    domain.DocumentRepository
    folderRepo domain.FolderRepository
    logger     *slog.Logger
}

func (s *DocumentService) CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*Document, error) {
    // Business logic: validation
    if err := s.validateDocumentRequest(req); err != nil {
        return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
    }

    // Business logic: resolve path to folder_id
    folderID, err := s.resolvePath(ctx, req.Path)
    if err != nil {
        return nil, err
    }

    // Business logic: convert TipTap to markdown
    markdown := s.convertTipTapToMarkdown(req.ContentTipTap)

    // Data access via repository
    doc := &Document{
        FolderID: folderID,
        Name:     extractName(req.Path),
        Content:  req.ContentTipTap,
        Markdown: markdown,
    }

    if err := s.docRepo.Create(ctx, doc); err != nil {
        return nil, err
    }

    return doc, nil
}
```

### Repository Layer (Data Access)

**Responsibilities:**
- Execute database queries
- Map between domain models and database rows
- Handle database-specific errors
- Provide transaction support

**Should NOT:**
- Contain business logic
- Validate business rules
- Know about HTTP layer

**Best Practices:**
- Define interfaces in domain layer, implement in infrastructure layer
- Repository methods return domain models, not database-specific types
- Use context.Context for query cancellation
- Provide transaction-aware methods

**Example:**
```go
// Domain layer interface
type DocumentRepository interface {
    Create(ctx context.Context, doc *Document) error
    GetByID(ctx context.Context, id, projectID string) (*Document, error)
    Update(ctx context.Context, doc *Document) error
    Delete(ctx context.Context, id, projectID string) error
}

// Infrastructure layer implementation
type PostgresDocumentRepository struct {
    pool   *pgxpool.Pool
    tables *TableNames
}

func (r *PostgresDocumentRepository) Create(ctx context.Context, doc *Document) error {
    query := fmt.Sprintf(`
        INSERT INTO %s (project_id, folder_id, name, content_tiptap, content_markdown)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at, updated_at
    `, r.tables.Documents)

    err := r.pool.QueryRow(ctx, query,
        doc.ProjectID, doc.FolderID, doc.Name, doc.ContentTipTap, doc.ContentMarkdown,
    ).Scan(&doc.ID, &doc.CreatedAt, &doc.UpdatedAt)

    if err != nil {
        if isPgDuplicateError(err) {
            return domain.ErrConflict
        }
        return fmt.Errorf("create document: %w", err)
    }

    return nil
}
```

---

## Recommended Packages

### 1. Database Driver: pgx

**Current:** `database/sql` with `lib/pq` driver
**Recommended:** `github.com/jackc/pgx/v5`

**Why pgx:**
- 3-5x faster than lib/pq for PostgreSQL
- Native support for PostgreSQL-specific features
- Better JSONB handling (important for TipTap JSON)
- Context-aware from the ground up
- Better error messages
- Connection pooling built-in

**Installation:**
```bash
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/pgxpool
```

**Usage:**
```go
pool, err := pgxpool.New(ctx, databaseURL)
defer pool.Close()

// Query
var doc Document
err := pool.QueryRow(ctx, "SELECT * FROM documents WHERE id = $1", id).Scan(...)
```

---

### 2. Logging: log/slog

**Current:** `fmt.Printf` with debug statements
**Recommended:** `log/slog` (Go 1.21+ stdlib)

**Why slog:**
- Built into standard library (zero dependencies)
- Structured logging (JSON output)
- Fast (40 B/op, similar to zerolog)
- Future-proof (official Go solution)
- Handler interface for customization

**Alternatives:**
- **zerolog**: Fastest option, but external dependency
- **zap**: Most customizable, but overkill for most apps

**Installation:** None (stdlib)

**Usage:**
```go
import "log/slog"

logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))

logger.Info("document created",
    "id", doc.ID,
    "project_id", projectID,
    "folder_id", folderID,
)
```

---

### 3. Background Jobs: River

**Current:** None
**Recommended:** `github.com/riverqueue/river`

**Why River:**
- PostgreSQL-backed (no additional infrastructure needed)
- **Transactional job enqueueing** - atomic with database writes
- Built-in retries, scheduling, priorities
- Perfect for LLM/embedding generation jobs
- Released 2024, actively maintained

**Alternatives:**
- **Asynq** (Redis-backed): More mature, has web UI, but requires Redis
- **Machinery**: Multi-broker support, but last updated 2021

**Why River for Meridian:**
- You already have PostgreSQL
- Transactional jobs prevent race conditions (create doc + enqueue embedding job atomically)
- No extra infrastructure to manage

**Installation:**
```bash
go get github.com/riverqueue/river
```

**Usage:**
```go
// Define job
type GenerateEmbeddingArgs struct {
    DocumentID string
    ProjectID  string
}

func (GenerateEmbeddingArgs) Kind() string { return "generate_embedding" }

// Enqueue job transactionally with document creation
tx, _ := pool.Begin(ctx)
defer tx.Rollback(ctx)

// Create document
_, err := tx.Exec(ctx, "INSERT INTO documents ...")

// Enqueue embedding job in same transaction
_, err = riverClient.InsertTx(ctx, tx, GenerateEmbeddingArgs{
    DocumentID: docID,
    ProjectID:  projectID,
}, nil)

tx.Commit(ctx) // Both succeed or both fail
```

---

### 4. Validation: ozzo-validation

**Current:** Scattered validation in handlers, utils, database layer
**Recommended:** `github.com/go-ozzo/ozzo-validation/v4`

**Why ozzo-validation:**
- Code-based validation (not struct tags)
- Supports complex conditional logic
- Easy to test
- Better error messages

**Alternatives:**
- **go-playground/validator**: Tag-based, good for simple DTOs

**Why ozzo for Meridian:**
- Complex path validation logic
- Folder hierarchy validation
- Conditional validation (path OR folder_id + name)

**Installation:**
```bash
go get github.com/go-ozzo/ozzo-validation/v4
```

**Usage:**
```go
import validation "github.com/go-ozzo/ozzo-validation/v4"

func (s *DocumentService) validateCreateRequest(req *CreateDocumentRequest) error {
    return validation.ValidateStruct(req,
        validation.Field(&req.Path,
            validation.When(req.FolderID == nil, validation.Required),
            validation.Length(1, 500),
            validation.By(validateDocumentPath),
        ),
        validation.Field(&req.Name,
            validation.When(req.Path == nil, validation.Required),
            validation.Length(1, 255),
        ),
        validation.Field(&req.ContentTipTap, validation.Required),
    )
}
```

---

### 5. LLM Streaming: Server-Sent Events (SSE)

**Current:** None
**Recommended:** Native SSE (no library needed)

**Why SSE:**
- Perfect for one-way streaming (server → client)
- Native browser support with auto-reconnect
- Simpler than WebSockets for streaming use cases
- HTTP/2 compatible

**When to use WebSockets instead:**
- Need bidirectional communication
- Need binary data streaming
- Need custom protocols

**Why SSE for Meridian:**
- LLM responses are one-way streams (server → client)
- Simpler implementation
- Built-in reconnection logic in browsers

**Usage (with Fiber):**
```go
func (h *StreamHandler) StreamDocument(c *fiber.Ctx) error {
    c.Set("Content-Type", "text/event-stream")
    c.Set("Cache-Control", "no-cache")
    c.Set("Connection", "keep-alive")
    c.Set("X-Accel-Buffering", "no") // Disable nginx buffering

    ctx := c.Context()

    // Stream from LLM
    for chunk := range h.llmService.GenerateDocument(ctx, prompt) {
        fmt.Fprintf(c, "data: %s\n\n", chunk)
        c.Ctx().Response.Flush()

        if ctx.Done() {
            break // Client disconnected
        }
    }

    return nil
}
```

**Client-side (JavaScript):**
```javascript
const eventSource = new EventSource('/api/documents/123/stream');
eventSource.onmessage = (event) => {
    console.log('Received:', event.data);
};
```

---

### 6. Dependency Injection: Manual → Wire (if needed)

**Current:** Mixed (some constructor injection, some closure capture)
**Recommended:** Start with manual DI, add Wire if it becomes painful

**Manual DI (Recommended Start):**
```go
// cmd/server/main.go
func main() {
    // Create infrastructure
    pool := createDatabasePool()
    logger := slog.New(...)

    // Create repositories
    docRepo := postgres.NewDocumentRepository(pool, tables)
    folderRepo := postgres.NewFolderRepository(pool, tables)

    // Create services
    docService := service.NewDocumentService(docRepo, folderRepo, logger)
    folderService := service.NewFolderService(folderRepo, logger)

    // Create handlers
    docHandler := handler.NewDocumentHandler(docService, logger)
    folderHandler := handler.NewFolderHandler(folderService, logger)

    // Register routes
    app.Post("/api/documents", docHandler.CreateDocument)
}
```

**Wire (Add Later If Needed):**
- Compile-time dependency injection
- Code generation (no reflection)
- Zero runtime overhead

**Installation:**
```bash
go install github.com/google/wire/cmd/wire@latest
```

---

### 7. Error Handling: Sentinel Errors + errors.Is

**Current:** Error string matching
**Recommended:** Sentinel errors with `errors.Is`

**Pattern:**
```go
// domain/errors.go
package domain

import "errors"

var (
    ErrNotFound      = errors.New("not found")
    ErrConflict      = errors.New("already exists")
    ErrValidation    = errors.New("validation failed")
    ErrUnauthorized  = errors.New("unauthorized")
)

// Service layer
func (s *DocumentService) GetDocument(ctx, id string) (*Document, error) {
    doc, err := s.repo.GetByID(ctx, id)
    if err != nil {
        if errors.Is(err, domain.ErrNotFound) {
            return nil, fmt.Errorf("document %s: %w", id, domain.ErrNotFound)
        }
        return nil, fmt.Errorf("get document: %w", err)
    }
    return doc, nil
}

// Handler layer
func mapErrorToHTTP(err error) error {
    switch {
    case errors.Is(err, domain.ErrNotFound):
        return fiber.NewError(fiber.StatusNotFound, "Resource not found")
    case errors.Is(err, domain.ErrConflict):
        return fiber.NewError(fiber.StatusConflict, "Resource already exists")
    case errors.Is(err, domain.ErrValidation):
        return fiber.NewError(fiber.StatusBadRequest, err.Error())
    case errors.Is(err, domain.ErrUnauthorized):
        return fiber.NewError(fiber.StatusUnauthorized, "Unauthorized")
    default:
        return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
    }
}
```

---

## Transaction Patterns

### The Problem

Multi-step operations need atomicity:
- Create document + enqueue embedding job
- Create folder hierarchy (multiple folders)
- Update document + update folder counts

### Best Practice: Transaction Helper

**Pattern from Three Dots Labs:**

```go
// repository/postgres/transaction.go
type TxFn func(pgx.Tx) error

func (r *Repository) execTx(ctx context.Context, fn TxFn) error {
    tx, err := r.pool.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }

    // Defer rollback - safe even if commit succeeds
    defer func() {
        if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
            r.logger.Error("rollback failed", "error", err)
        }
    }()

    // Execute function
    if err := fn(tx); err != nil {
        return err
    }

    // Commit
    if err := tx.Commit(ctx); err != nil {
        return fmt.Errorf("commit transaction: %w", err)
    }

    return nil
}
```

**Usage in Service:**

```go
func (s *DocumentService) CreateDocumentWithEmbedding(ctx context.Context, req *CreateDocRequest) error {
    return s.repo.execTx(ctx, func(tx pgx.Tx) error {
        // Create document
        doc := &Document{...}
        if err := s.docRepo.CreateTx(ctx, tx, doc); err != nil {
            return err
        }

        // Enqueue embedding job (transactional with River)
        _, err := s.riverClient.InsertTx(ctx, tx, GenerateEmbeddingArgs{
            DocumentID: doc.ID,
        }, nil)

        return err
    })
}
```

### Key Rules

1. **Defer rollback** - Safe even if commit succeeds
2. **Context throughout** - All queries use same context
3. **No cross-connection calls** - Once in transaction, use tx for all queries
4. **Single connection** - Transaction binds to one connection until commit/rollback

---

## References

### Articles
- [The Repository Pattern in Go (Three Dots Labs)](https://threedots.tech/post/repository-pattern-in-go/)
- [Database Transactions in Go with Layered Architecture (Three Dots Labs)](https://threedots.tech/post/database-transactions-in-go/)
- [Mastering DDD: Repository Design Patterns in Go](https://yottahmd.medium.com/mastering-ddd-repository-design-patterns-in-go-2034486c82b3)
- [Best Go Logging Tools in 2025 (Dash0)](https://www.dash0.com/faq/best-go-logging-tools-in-2025-a-comprehensive-guide)
- [Go Dependency Injection Approaches - Wire vs. fx (Leapcell)](https://leapcell.io/blog/go-dependency-injection-approaches-wire-vs-fx-and-manual-best-practices)

### GitHub Repositories
- [golang-standards/project-layout](https://github.com/golang-standards/project-layout)
- [jackc/pgx](https://github.com/jackc/pgx)
- [riverqueue/river](https://github.com/riverqueue/river)
- [go-ozzo/ozzo-validation](https://github.com/go-ozzo/ozzo-validation)

### Package Documentation
- [pgx documentation](https://pkg.go.dev/github.com/jackc/pgx/v5)
- [log/slog documentation](https://pkg.go.dev/log/slog)
- [River documentation](https://riverqueue.com/docs)
- [ozzo-validation documentation](https://pkg.go.dev/github.com/go-ozzo/ozzo-validation/v4)
