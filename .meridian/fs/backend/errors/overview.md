# Error System Overview

The backend has two error systems — `DomainError` (structured, code-based) and typed sentinel errors (RFC 7807). Both are active in handlers.

## Error Types

| System | Shape | HTTP status owner | Transport envelope |
| --- | --- | --- | --- |
| `DomainError` | `{code, status, message, detail}` | Constructor functions in `domain/errors/errors.go` | JSON `{code, message, detail}` |
| Typed sentinel errors | `*NotFoundError`, `*ValidationError`, `*InsufficientCreditsError`, etc. | `handler/helpers.go` mapping | RFC 7807 `application/problem+json` |

## Domain Error Codes

| Group | Codes | HTTP status |
| --- | --- | --- |
| Work item lifecycle | `WORK_ITEM_DONE`, `WORK_ITEM_DELETED`, `WORK_ITEM_HAS_ACTIVE_STREAMS` | `409` |
| Persona | `PERSONA_NOT_FOUND`, `PERSONA_INVALID` | `422` |
| Skill | `SKILL_NOT_FOUND`, `SKILL_INVALID` | `404` for not found, `422` for invalid |
| Spawn/concurrency | `SPAWN_DEPTH_EXCEEDED`, `SPAWN_LIMIT_EXCEEDED` | `429` |
| Access control | `NAMESPACE_ACCESS_DENIED`, `PATH_TRAVERSAL_DENIED` | `403` |
| Payload | `CONTEXT_BUDGET_EXCEEDED` | `413` |
| Import | `IMPORT_VALIDATION_FAILED` | `422` |

`PersonaNotFound` intentionally returns `422` because the request shape is valid but the persona reference is invalid.

## Response Envelope Routing

`handleError` checks `*DomainError` first and short-circuits to `{code, message, detail}`, then falls back to typed domain errors and sentinel errors that render RFC 7807 problem details.

## Error Flow

1. Repository emits typed errors or maps database conditions into domain errors.
2. Service layer translates security-sensitive cases like not-found into forbidden for ownership checks.
3. Handler serializes either DomainError JSON or RFC 7807 problem details.

## File References

| Area | File references |
| --- | --- |
| `DomainError` type + constructor-owned statuses | `backend/internal/domain/errors/errors.go:18`, `backend/internal/domain/errors/errors.go:31`, `backend/internal/domain/errors/errors.go:72` |
| Error code constants | `backend/internal/domain/errors/codes.go:8` |
| Typed sentinel errors | `backend/internal/domain/errors.go:7`, `backend/internal/domain/errors.go:57` |
| Handler routing (`DomainError` first) | `backend/internal/handler/helpers.go:93`, `backend/internal/handler/helpers.go:97`, `backend/internal/handler/helpers.go:140` |
| RFC 7807 envelope | `backend/internal/httputil/response.go:24`, `backend/internal/httputil/response.go:58`, `backend/internal/httputil/response.go:76` |
| Service rewrite for existence leak prevention | `backend/internal/service/auth/owner_authorizer.go:46`, `backend/internal/service/auth/owner_authorizer.go:51` |
| Repository-level error mapping example | `backend/internal/repository/postgres/billing/credit_store.go:354` |
