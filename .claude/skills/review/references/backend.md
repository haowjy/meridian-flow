# Backend Patterns (Go + Clean Architecture)

Common patterns LLMs get wrong in this codebase. Check every backend diff against these.

## Use the Service Layer

**Why**: Clean Architecture exists so that business logic is testable, portable, and independent of transport. When an LLM puts validation logic in a handler or has a handler call a repository directly, it couples business rules to HTTP — making them untestable without spinning up a server, unreusable from other entry points (CLI, workers, WebSocket handlers), and harder to reason about. The service layer is the single place where "what the app does" lives.

**The pattern**:
- **Handlers** validate input and map HTTP ↔ domain. No business logic.
- **Services** implement business logic. They call repositories, not the other way around.
- **Repositories** do data access only. No business decisions.

If you see business logic in a handler or a handler calling a repository directly, flag it.

## Domain Errors, Not HTTP Errors

**Why**: Services don't know they're behind HTTP. Today it's a REST API; tomorrow it could be gRPC, a CLI tool, or a WebSocket handler. If services return `http.StatusNotFound`, every new transport has to understand HTTP semantics. Domain errors (`ErrNotFound`, `ErrValidation`) are transport-agnostic — each handler maps them to its own protocol. This also makes error handling testable without HTTP fixtures.

**The pattern**: Services return domain errors. Handlers map them to HTTP status codes. Services should never import `net/http` or know about status codes.

## Terminal Error Policy Must Be Operation-Scoped

**Why**: The same status code does not imply the same action across operations. A 404 on `GetByID` can mean "entity is gone" and should reconcile stale local projections. A 404 on list pagination, auth/session, or external dependency paths often should not delete anything. Global "always prune on 404" logic causes data loss and inconsistent behavior.

**The pattern**:
- Define error handling per operation (`GetByID`, `List`, `Search`, `Stream`, `Session`, etc.), not per status code globally.
- For authoritative `GetByID` reads, map `ErrNotFound` to explicit reconciliation when appropriate (cache/index cleanup, pending-queue cleanup).
- For transient failures (timeouts/network/5xx), retry or degrade gracefully; do not prune durable state.
- Make reconciliation idempotent and race-safe (safe to run twice, safe under concurrent requests).
- Keep policy centralized so all handlers/callers apply the same rules.

If you see blanket terminal-error handling that ignores operation semantics, flag it.

## Null vs Empty vs Omitted Are Three Different Things

**Why**: Go's standard `encoding/json` has no way to distinguish "field was absent from JSON" from "field was `null`" — both result in a nil pointer. But for PATCH semantics (RFC 7396), these are three distinct user intents:
- **Omitted**: "don't change this field"
- **`null`**: "clear this field" (e.g., move document to root, clear system prompt)
- **`""`**: "set this field to empty string" (valid value, different from clearing)

Collapsing these loses user intent. A user clearing their system prompt (`null`) is not the same as never setting one (omitted), and neither is the same as setting it to `""`.

**The pattern**: This codebase uses `optional.Optional[T]` (see `internal/optional/optional.go`) for tri-state PATCH fields:

```go
type Optional[T any] struct {
    Present bool  // true = field was in JSON (even if null)
    Value   *T    // nil = JSON null, non-nil = has value
}
```

| JSON input | `Present` | `Value` | Meaning |
|------------|-----------|---------|---------|
| field absent | `false` | `nil` | Don't change |
| `"field": null` | `true` | `nil` | Clear/set to NULL |
| `"field": ""` | `true` | `&""` | Set to empty string |
| `"field": "hello"` | `true` | `&"hello"` | Set to value |

Use `optional.Optional[T]` for any PATCH request field where the user might want to clear a value. Don't use bare `*string` for PATCH fields — it can't distinguish omitted from null. See `handler/project.go`, `handler/document.go`, `handler/folder.go` for usage examples.

## Wrap Errors With Context

**Why**: When a production error shows `"record not found"`, you don't know if it was a user lookup, a document fetch, a thread load, or a skill query. Every layer in the call chain knows *what it was trying to do* — that context is lost if you return bare errors. Wrapped errors create a breadcrumb trail: `"loading thread abc123: fetching turns: record not found"` tells you exactly where to look.

**The pattern**: `fmt.Errorf("loading document %s: %w", id, err)` — not bare `return err`. Every layer adds context about what it was doing.

## Validate at the Boundary

**Why**: If handlers validate, services validate, and repositories validate the same constraints, you get three places to update when rules change, three places where validation can diverge, and unnecessary overhead on internal calls. The handler is the boundary — it's the one place where untrusted input enters the system. After that, services trust that input is valid. This keeps the service layer focused on business logic, not re-checking what the handler already checked.

**The pattern**: Validate input once in the handler. Services trust validated input. Don't scatter validation checks deep in the call chain.

Note: WebSocket messages have their own validation layer — the WS message loop handler validates inbound frames, separate from HTTP middleware.

## Normalize External Ingress Before Canonical Writes

**Why**: External payloads (HTTP DTOs, provider events, background feeds) can be malformed, partial, or out of order. Writing them directly into canonical state creates long-lived corruption that later code assumes is impossible.

**The pattern**:
- Normalize and validate external snapshots before persisting/updating canonical state.
- Reject or drop malformed records (missing required identifiers, invalid references, impossible timestamps).
- Keep normalization in one shared path per entity to avoid drift between ingest codepaths.

If multiple ingest paths apply different normalization rules for the same entity, flag it.

## Database: Know the Pooler Limitation

**Why**: Supabase routes connections through PgBouncer (port 6543) for connection pooling. PgBouncer's transaction mode doesn't support PostgreSQL's extended query protocol (prepared statements), because prepared statements are per-connection and PgBouncer reassigns connections between queries. If code uses the default query mode, queries silently fail or produce wrong results. The codebase auto-detects this and uses `QueryExecModeCacheDescribe` — but you need to be aware of it when writing raw queries or configuring new database connections.

**The pattern**: See `internal/repository/postgres/connection.go` for the auto-detection logic.

## RFC 7807 Problem Details for All Error Responses

**Why**: All HTTP error responses use the RFC 7807 Problem Details format. This gives the frontend a consistent contract for error parsing — every error has a machine-readable `type` URI, human-readable `title` and `detail`, and an HTTP `status`. The frontend's `AppError` class depends on this structure.

**The pattern**:
```go
// Every error response includes:
{
    "type":   "https://meridian.app/problems/not-found",
    "title":  "Not Found",
    "status": 404,
    "detail": "document abc123 not found"
}
```

- Use `httputil.RespondError()` for standard errors, `httputil.RespondProblem()` for custom problem types
- 409 Conflict responses MUST include a `resource` field with the existing entity (frontend shows "already exists" with a link)
- See `handler/helpers.go:HandleCreateConflict()` for the 409 pattern

**What goes wrong**: Returning `{"error": "message"}` instead of RFC 7807 format breaks the frontend error parser. Returning 409 without the existing resource forces a separate lookup.

## Go 1.22+ ServeMux: Route Ordering Matters

**Why**: The router uses Go 1.22's enhanced `http.ServeMux` with method-specific routing (`GET /api/projects`) and path parameters (`/api/projects/{id}` → `r.PathValue("id")`). But path parameter routes swallow more-specific literal routes if registered first.

**The pattern**:
- `/api/documents/search` MUST come before `/api/documents/{id}` — otherwise `search` matches as an `{id}` value
- Method prefix is required: `GET /api/...` not just `/api/...`
- Path params via `r.PathValue("id")` — not gorilla/mux or chi patterns
- See `cmd/server/main.go` for the full route table

**What goes wrong**: Registering `{id}` routes before literal routes at the same path level. Using third-party router patterns. Forgetting the HTTP method prefix.

## Test Doubles: fake* Prefix, Not mock*

**Why**: Test implementations use the `fake` prefix (`fakeProposalStore`, `fakeIdempotencyStore`). They implement full interfaces with in-memory state, `sync.Mutex` for thread safety, call counting, and failure injection. No mocking framework is used.

**The pattern**:
- `type fakeDocStore struct { ... }` with `sync.Mutex`
- Implement the full interface — no partial mocks
- Add `calls` counter and `err` field for failure injection
- See `handler/collab_test.go`, `service/collab/proposal_service_test.go`

**What goes wrong**: Using `mock` prefix (inconsistent naming). Using a mocking framework (not used in this codebase). Forgetting `sync.Mutex` on fakes used from goroutines (race detector failures).
