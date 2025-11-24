---
stack: backend
status: complete
feature: "Backend Infrastructure"
---

# Backend Infrastructure

**Error handling, database features, CORS, logging.**

## Status: ✅ Complete

---

## Error Handling

**Domain Errors**: `ErrNotFound`, `ErrConflict`, `ErrUnauthorized`, `ErrValidation`
**HTTP Mapping**: Automatic error → HTTP status mapping
**Recovery Middleware**: Panic recovery, 500 Internal Server Error

**Files**: `backend/internal/domain/errors.go`, `backend/internal/middleware/recovery.go`

---

## Database Features

**Soft Delete**: `deleted_at` timestamp on all tables
**Timestamps**: Auto-update `updated_at` via trigger
**RLS**: Row-level security enabled
**Transactions**: DBTX interface for propagation
**Dynamic Table Names**: Environment-based prefix

**Files**: `backend/internal/repository/postgres/`

---

## CORS

**Configurable origins**: Via `CORS_ORIGINS` env var
**Credentials support**: Cookies allowed
**Library**: `rs/cors`

---

## Logging

**Structured logging**: `log/slog`
**JSON output**: Production-ready
**Environment-based log level**: dev: DEBUG, prod: INFO

---

## Related

- See `/_docs/technical/backend/architecture/` for details
