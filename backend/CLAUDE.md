# Backend - Claude Instructions

Backend-specific guidance for Claude Code. For general project info, see `/CLAUDE.md`.

## Quick Start

```bash
# First time setup
cp .env.example .env
# Edit .env with Supabase credentials
go mod download

# Run schema in Supabase SQL Editor (one-time)
# Copy contents of schema.sql → Supabase Dashboard → SQL Editor → Run

# Seed test data (creates test project + sample documents)
make seed

# Start server
make run
```

## Development Commands

```bash
make run          # Start server
make dev          # Start with hot reload (requires air)
make build        # Build binary
make test         # Run tests
make seed         # Seed via API
make seed-fresh   # Drop tables + seed
make seed-clear   # Clear data (keep schema)
```

## Server Management (IMPORTANT)

**User manages the server, not Claude:**
- User starts/stops/restarts server
- Claude suggests commands: `make run`, `make dev`
- Claude CAN run curl to test endpoints (once server running)
- If tests fail, Claude informs user + suggests restart

## API Testing

**Manual testing:** Import Insomnia collections from `tests/insomnia/` (see collection list below)

**Automated testing:** Claude can run curl:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/projects
curl http://localhost:8080/api/projects/<PROJECT_ID>/tree
curl http://localhost:8080/api/documents/:id
```

**Insomnia test collections:** Import from `tests/insomnia/`:
- `00-health.json` - Server health check (1 request)
- `01-file-system-crud.json` - Core CRUD operations (25 requests)
- `02-file-system-import.json` - Bulk import testing (10 requests)
- `03-file-system-advanced.json` - Integration tests and workflows (27 requests)
- `04-chat.json` - Complete chat and LLM testing (29 requests)

See `tests/insomnia/README.md` for detailed collection guide.

## Architecture

Uses Clean Architecture (Hexagonal):
```
cmd/server/main.go           → Entry point
internal/handler/            → HTTP layer (Fiber)
internal/service/            → Business logic
internal/repository/postgres → Data layer
internal/domain/             → Interfaces + models
```

## Critical Conventions

### 1. Dynamic Table Names

**Always use `db.Tables.*`, never hardcode:**

```go
// ✅ Correct
query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", db.Tables.Documents)

// ❌ Wrong
query := "SELECT * FROM documents WHERE id = $1"
```

See `internal/repository/postgres/` for examples.

### 2. Markdown Content Storage

Documents store content as **markdown** (TEXT):
- Single source of truth
- Used for word count, search, and storage
- Frontend handles markdown ↔ editor conversion

No server-side format conversion required.

### 3. Error Handling

Use Fiber errors:
```go
return fiber.NewError(fiber.StatusBadRequest, "Invalid input")
```

See `internal/handler/errors.go` for error mapping.

## Environment Variables

Required:
- `SUPABASE_DB_URL` - Port 6543 auto-configures for PgBouncer compatibility
- `ENVIRONMENT` - `dev`, `test`, or `prod` (determines table prefix)
- `PORT` - Default 8080
- `TEST_USER_ID`, `TEST_PROJECT_ID` - Phase 1 auth stubs

See `.env.example` for full list and `ENVIRONMENTS.md` for details.

## Common Issues

**"prepared statement already exists"** → Ensure using port 6543 (auto-configured) or add `?default_query_exec_mode=simple_protocol`. If error persists, restart Supabase project in dashboard.
See `_docs/technical/backend/database-connections.md`

**JSONB encoding errors** → Ensure using correct query execution mode (simple protocol for PgBouncer)

**Seeding fails** → Run `make seed-fresh` (drops tables first)

## Production Safety

`make seed-clear` and `make seed-fresh` are **BLOCKED** when `ENVIRONMENT=prod`. This prevents accidental data loss in production. Normal seeding (adding data) is still allowed.

## Documentation

- **Technical docs**: `_docs/technical/backend/`
- **Environment setup**: `ENVIRONMENTS.md`
- **API examples**: `tests/insomnia-collection.json`
- **Seeding**: `scripts/README.md`

## Server Configuration

### HTTP Timeouts

**Production (hardened):**
- `ReadTimeout`: 15 seconds - Maximum time to read request
- `WriteTimeout`: 30 seconds - Maximum time to write response
- `IdleTimeout`: 60 seconds - Maximum keep-alive time

**Purpose:** Prevents hung connections, slowloris attacks, and resource exhaustion.

**Configuration:** See `cmd/server/main.go:93-97`

### Validation Rules

**Name Normalization:**
- All names (projects, folders, documents) are automatically trimmed of leading/trailing whitespace
- Internal behavior, transparent to API clients

**Folder/Document Name Restrictions:**
- Folder names **cannot contain** `/` (used in path construction)
- Document names **cannot contain** `/` (filesystem semantics)
- Validation regex: `^[^/]+$`
- Import automatically sanitizes `/` to `-` in document names

**See:** `_docs/technical/backend/api/contracts.md` for complete validation rules

## Phase 1 Auth Stub

No real auth yet. Uses hardcoded IDs from `.env`:
- Middleware injects `TEST_USER_ID` into context
- All operations use `TEST_PROJECT_ID`
- Test project created by `make seed` (not by server on startup)
- Don't build multi-project logic yet

See `internal/middleware/auth.go` and `cmd/seed/main.go:ensureTestProject`.
