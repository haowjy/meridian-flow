# Backend Architecture Principles

Clean architecture rules for all v1 backend work. Every new feature must follow these layer boundaries.

## Layers

```
cmd/server/main.go          → wiring only (DI, server start)
internal/handler/            → transport (HTTP, WebSocket, SSE)
internal/middleware/         → transport-layer cross-cutting (JWT extraction, CORS, logging, rate limiting)
internal/service/            → business logic (orchestration, rules, validation)
internal/domain/             → entities, value objects, interfaces (zero external imports)
internal/repository/postgres → data access (implements domain interfaces)
```

## The Dependency Rule

Imports only point inward. Never outward, never sideways across layers at the same level.

```
handler   → service → domain ← repository
middleware → service → domain ← repository
```

- `domain/` imports nothing from the project. Only stdlib and value types.
- `service/` imports `domain/`. Never imports `handler/`, `repository/`, `middleware/`.
- `handler/` imports `service/` and `domain/` (for types). Never imports `repository/`.
- `repository/` imports `domain/` (to implement interfaces). Never imports `service/` or `handler/`.
- `middleware/` imports `service/` (to delegate business logic). Never contains business rules itself.

## Where Things Live

### Domain (`internal/domain/`)

Pure business entities and interface definitions.

- **Entities:** `CreditLot`, `WorkItem`, `Proposal`, `Document`
- **Interfaces:** `CreditService`, `SkillResolver`, `ProposalStore`, `DocumentStore`
- **Value objects:** credit amounts, paths, slugs
- **Zero imports** from postgres, HTTP, WebSocket, or any framework

Test: if you can't describe it without mentioning a database or HTTP verb, it doesn't belong here.

### Service (`internal/service/`)

Business logic that orchestrates domain operations.

- Receives dependencies via constructor injection (interfaces from domain)
- Implements business rules: credit checks, FIFO consumption, write routing, skill resolution
- Returns domain errors, not HTTP status codes

```go
// ✅ Service returns domain error
func (s *CreditService) CheckBalance(ctx context.Context, userID uuid.UUID) error {
    balance, err := s.creditStore.GetBalance(ctx, userID)
    if err != nil { return err }
    if balance <= 0 { return domain.ErrInsufficientCredits }
    return nil
}

// ❌ Service returns HTTP status
func (s *CreditService) CheckBalance(...) (int, error) {
    return http.StatusPaymentRequired, errors.New("insufficient credits")
}
```

### Handler (`internal/handler/`)

Transport layer. Parse request, call service, format response.

- Extracts params from URL/body/context
- Calls service methods
- Maps domain errors to HTTP status codes (see `errors.go`)
- No business logic — if you need an `if` that isn't about parsing, it belongs in service

```go
// ✅ Handler delegates to service
func (h *ThreadHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
    userID := auth.UserIDFromContext(r.Context())
    req := parseRequest(r)
    result, err := h.threadService.SendMessage(r.Context(), userID, req.ThreadID, req.Content)
    if err != nil {
        httputil.RespondDomainError(w, err) // maps domain errors → HTTP codes
        return
    }
    httputil.RespondJSON(w, http.StatusOK, result)
}

// ❌ Handler contains business logic
func (h *ThreadHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
    balance := h.creditStore.GetBalance(ctx, userID) // reaching past service into repo
    if balance < estimateCost(req.Model) { ... }     // business logic in handler
}
```

### Middleware (`internal/middleware/`)

Transport-layer cross-cutting concerns. Thin wrappers that delegate to services.

**Belongs in middleware:**
- JWT extraction → inject user ID into context
- Request logging, CORS, panic recovery
- Rate limiting (transport concern — "how many requests per second")

**Does NOT belong in middleware:**
- Credit balance checks → service layer (business rule)
- Authorization ("can this user access this project?") → service layer
- Write routing by path → service layer

**Pattern for business-adjacent middleware:** delegate to service, don't contain logic.

```go
// ✅ Thin middleware delegates to service
func CreditGate(creditSvc domain.CreditService) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userID := auth.UserIDFromContext(r.Context())
            if err := creditSvc.CheckBalance(r.Context(), userID); err != nil {
                httputil.RespondDomainError(w, err)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// ❌ Fat middleware with business logic
func CreditGate(db *pgxpool.Pool) func(http.Handler) http.Handler {
    // queries DB directly, computes FIFO, checks expiration...
}
```

### Repository (`internal/repository/postgres/`)

Implements domain interfaces. Only knows SQL and domain types.

- One file per aggregate/entity
- Uses `db.Tables.*` for table names (never hardcoded)
- Returns domain types, not sql.Row or pgx types
- Implements interfaces defined in `domain/`

## Layer Ownership for v1 Features

| Concern | Layer | Why |
|---------|-------|-----|
| Credit balance check (> 0) | Service (`CreditService`) | Business rule |
| FIFO lot consumption | Repository (`CreditStore`) | Data operation implementing domain interface |
| Credit deduction after inference | Service (`BillingService`) | Orchestrates check + deduct + log |
| Thin credit gate on AI endpoints | Middleware (delegates to `CreditService`) | Cross-cutting transport concern, but logic lives in service |
| Stripe webhook handling | Handler → Service | Handler parses Stripe event, service creates credit lot |
| Webhook idempotency | Repository (UNIQUE constraint) | Data-layer concern |
| Skill resolution from .agents/ | Service (`SkillResolver`) | Business logic: find file, parse frontmatter |
| Skill file read | Repository (`DocumentStore`) | Data access |
| Write routing by target path | Service (`WriteRouter`) | Business rule: path → mechanism |
| Context variable injection | Service (`AgentContextService`) | Business logic: resolve $MERIDIAN_WORK_DIR |
| .agents/ write routing (review-gated) | Service (`WriteRouter`) | Business rule: writes to .agents/ accepted but marked autoapply=false for user review |
| Git import clone + create docs | Service (`AgentImportService`) | Orchestration; repo handles doc creation |
| Work item CRUD | Service → Repository | Standard CRUD through layers |
| Artifact space creation | Service (`WorkItemService`) | Creates folder via DocumentStore interface |
| Per-inference-step billing | Service (`StreamingBillingService`) | Check → allow inference → deduct after |
| SSE streaming | Handler (transport) | Handler manages SSE connection, service produces events |
| WebSocket (Yjs sync) | Handler (transport) | Handler manages WS, service handles Yjs ops |

## Interface Definition Rule

Interfaces are defined where they're consumed, not where they're implemented.

```go
// ✅ domain/interfaces.go — consumer defines the interface
type CreditStore interface {
    GetBalance(ctx context.Context, userID uuid.UUID) (int, error)
    DeductCredits(ctx context.Context, userID uuid.UUID, amount int, meta DeductionMeta) error
}

// ✅ repository/postgres/credit_store.go — implements domain interface
type creditStore struct { db *pgxpool.Pool }
func (s *creditStore) GetBalance(...) (int, error) { ... }
func (s *creditStore) DeductCredits(...) error { ... }
```

## Testing Rule

Each layer is testable in isolation:

- **Domain:** pure unit tests, no mocks needed
- **Service:** mock repository interfaces (defined in domain, easy to mock)
- **Handler:** mock service interfaces, test HTTP request/response
- **Repository:** integration tests against real DB (or test containers)

If you can't test a layer without importing another layer, the dependency rule is broken.
