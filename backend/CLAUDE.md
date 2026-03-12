# Backend - Agent Instructions

Backend-specific guidance for Agents. For general project info, see `/AGENTS.md`.

## Quick Start

```bash
# Option A: Local Supabase (recommended)
# From repo root:
./scripts/dev/supabase-start.sh   # starts Docker containers, patches .env, runs migrations
make seed                          # seed test data

# Option B: Cloud Supabase
cp .env.example .env
# Edit .env with cloud Supabase credentials
go mod download
# Run schema in Supabase SQL Editor (one-time)
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

## Server Management

- Claude CAN restart the backend server via: `./scripts/restart-server.sh`
- Claude CAN run curl to test endpoints (once server running)
- Claude CAN run `./scripts/get-token.sh` to refresh `ACCESS_TOKEN` in root `.env` before authenticated smoke tests
- If tests fail, restart the server and re-test

## API Testing

**Automated testing:** Claude can run curl:
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/projects
curl http://localhost:8080/api/projects/<PROJECT_ID>/tree
curl http://localhost:8080/api/documents/:id
```

## Smoke Testing

- Scratchpad: `tmp/` at repo root (gitignored) for one-off curl scripts
- Get token: `./scripts/get-token.sh` (saves `ACCESS_TOKEN` to root `.env`)
  - Setup: `cp scripts/get-token.sh.example scripts/get-token.sh && chmod +x scripts/get-token.sh`
- Token refresh is agent-authorized: Claude may run `./scripts/get-token.sh` whenever the current token is expired
- Authenticated curl: `curl -H "Authorization: Bearer $(grep '^ACCESS_TOKEN=' .env | cut -d= -f2-)" http://localhost:8080/api/...`
- Existing smoke tests in `tmp/` — see `tmp/README.md`

## Architecture

Uses Clean Architecture (Hexagonal):
```
cmd/server/main.go           -> Entry point
internal/handler/            -> HTTP layer (net/http)
internal/service/            -> Business logic
internal/repository/postgres -> Data layer
internal/domain/             -> Interfaces + models
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

### 2. SQL Migration Rules (MANDATORY)

When creating or editing files in `backend/migrations/`:
- Include `-- +goose ENVSUB ON` (Up and Down sections).
- Prefix all app tables/functions with `${TABLE_PREFIX}`.
- Prefix all app index names with `idx_${TABLE_PREFIX}...`.
- Prefix all app constraint names with `${TABLE_PREFIX}...`.
- Do not hardcode `dev_`, `test_`, `prod_`, or unprefixed app table names.

Before writing migration SQL:
- Read existing migrations first to copy project patterns.
- At minimum inspect: `00001_initial_schema.sql`, the most recent migration, and one migration similar to your change.
- Follow existing goose patterns exactly (`Up/Down`, `StatementBegin/End` for plpgsql blocks).

### 3. Markdown Content Storage

Documents store content as **markdown** (TEXT):
- Single source of truth
- Used for word count, search, and storage
- Frontend handles markdown ↔ editor conversion

No server-side format conversion required.

### 4. Error Handling

Use standard HTTP error responses via `httputil` package:
```go
httputil.RespondError(w, http.StatusBadRequest, "Invalid input")
```

See `internal/handler/errors.go` for error mapping and `internal/httputil/` for response helpers.

#### Error Response Format

RFC 7807 Problem Details (`type`, `title`, `status`, `detail`). 409 Conflicts include generic `resource` field (not `document`/`project`) — use `RespondErrorWithExtras()`. See `internal/handler/errors.go` for mapping.

### 5. Local Development with Submodules

- **Local dev**: Uses `go.work` (already configured). Never use `replace` directives in `go.mod` (breaks Docker).
- **Production**: Tagged GitHub versions.
- **Auto-bump**: Patch versions for `meridian-llm-go` are auto-bumped by post-commit hook. Just commit `go.mod` + `go.sum` afterward.
- **Manual bumps**: `./scripts/update-libraries.sh "message"`
- **See**: `meridian-llm-go/CLAUDE.md`, `scripts/README.md`

## Environment Variables

Required (auto-configured by `supabase-start.sh` for local dev):
- `SUPABASE_DB_URL` - Local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Cloud: port 6543 auto-configures for PgBouncer
- `SUPABASE_URL` - Local: `http://127.0.0.1:54321`. Cloud: `https://your-project.supabase.co`
- `SUPABASE_KEY` - Local: JWT-format service_role key (auto-set). Cloud: `sb_secret_...` format
- `ENVIRONMENT` - `dev`, `test`, or `prod` (determines table prefix)
- `PORT` - Default 8080 (Railway auto-injects in production)
- `CORS_ORIGINS` - Comma-separated list of allowed frontend origins

LLM Configuration (at least one required):
- `ANTHROPIC_API_KEY` - For Claude models via Anthropic API
- `OPENROUTER_API_KEY` - For multiple providers via OpenRouter

Optional (Logging):
- `LOG_LEVEL` - `debug|info|warn|error` (default: `debug` in `ENVIRONMENT=dev`, otherwise `info`)
- `LOG_TO_FILE` - When true, logs to both stdout and a session file (default: false)
- `LOG_DIR` - Log directory (default: ./logs)
- `LOG_MAX_FILES` - Max session log files to keep (default: 10)
- `LLM_STREAM_DEBUG_LOGS` - Enables very verbose (redacted) provider streaming logs (default: false)

See `.env.example` for development and `.env.production.example` for deployment.

## Common Issues

**"prepared statement already exists"** -> Ensure using port 6543 (auto-configured) or add `?default_query_exec_mode=simple_protocol`. If error persists, restart Supabase project in dashboard.
See `_docs/technical/backend/database-connections.md`

**JSONB encoding errors** -> Ensure using correct query execution mode (simple protocol for PgBouncer)

**Seeding fails** -> Run `make seed-fresh` (drops tables first)

## Production Safety

`make seed-clear` and `make seed-fresh` are **BLOCKED** when `ENVIRONMENT=prod`. This prevents accidental data loss in production. Normal seeding (adding data) is still allowed.

## Documentation

- **Technical docs**: `_docs/technical/backend/`
- **Environment setup**: `ENVIRONMENTS.md`
- **Seeding**: `scripts/README.md`

## Server Configuration

### HTTP Timeouts

**Production (SSE-optimized):**
- `ReadTimeout`: 15 seconds - Maximum time to read request
- `WriteTimeout`: 0 (unlimited) - Allows long-lived SSE streams
- `IdleTimeout`: 60 seconds - Maximum keep-alive time

**Purpose:** Prevents hung connections while supporting Server-Sent Events for LLM streaming.

**Configuration:** See `cmd/server/main.go` (HTTP server setup)

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

## Authentication

Backend uses JWT validation via Supabase Auth:
- Middleware validates JWT tokens from `Authorization: Bearer <token>` header
- User ID extracted from JWT claims and injected into request context
- JWKS endpoint: `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`
- Allowed algorithms: RS256, ES256 (`internal/auth/jwt_verifier.go:64-68`)
- Local Supabase: uses ES256 via `supabase/signing_keys.json` (copied from `.example` by `supabase-start.sh`)
- Cloud Supabase: uses RS256 by default

See `internal/middleware/auth.go` for implementation.

## Streaming Architecture

**Status:** ✅ Working (catchup, multi-block, race conditions fixed)

### Key Pattern: Atomic PersistAndClear

**Always use `stream.PersistAndClear()`** — never separate persist and clear (race condition). `DEBUG=true` enables sequential event IDs. Lorem testing: use `lorem_max` parameter to control output length.

**See**: `_docs/technical/llm/streaming/README.md` (navigation hub) | `_docs/technical/backend/architecture/streaming-architecture.md`

## Tool System

SOLID-compliant tool system: `ToolExecutor` interface + `ToolRegistry` + `ToolRegistryBuilder` (fluent API). Tools: document tools (internal), web search (external via `SearchClient` interface). Auto-maps minimal tool names (`web_search`, `bash`, `text_editor`) to provider built-ins.

**See**: `_docs/technical/backend/tools/architecture.md` for full details (adding tools, providers, auto-mapping logic).

**Submodule testing**: See `meridian-stream-go/README.md` and `meridian-llm-go/README.md` for examples.
