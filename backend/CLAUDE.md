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
internal/handler/            → HTTP layer (net/http)
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

Use standard HTTP error responses via `httputil` package:
```go
httputil.RespondError(w, http.StatusBadRequest, "Invalid input")
```

See `internal/handler/errors.go` for error mapping and `internal/httputil/` for response helpers.

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

## Streaming Architecture

**Status:** ✅ Working (catchup, multi-block, race conditions fixed)

### Key Pattern: Atomic PersistAndClear

**Always use this pattern:**
```go
// ✅ Atomic persist-and-clear (prevents race conditions)
stream.PersistAndClear(func(events []mstream.Event) error {
    return db.SaveBlock(events)
})
```

**Never do this:**
```go
// ❌ Race condition: buffer cleared before DB commit
db.SaveBlock(events)
stream.ClearBuffer()
```

### DEBUG Mode

**Development:** `DEBUG=true` in `.env` - enables sequential event IDs for debugging

**Production:** `DEBUG=false` - no event IDs (better performance)

**Lorem Testing Parameters:**
- `lorem_max`: Limits lorem provider output to N words
- Works with any `lorem-*` model (`lorem-fast`, `lorem-slow`, `lorem-medium`)
- Overrides `max_tokens` when set
- Use cases:
  - Quick testing: Set `lorem_max` < `max_tokens` for fast responses
  - Cutoff simulation: Set `lorem_max` > `max_tokens` to test max_tokens limits
- Examples:
  ```json
  // Quick test (stops early)
  {
    "model": "lorem-slow",
    "max_tokens": 500,
    "lorem_max": 50
  }
  // Result: Lorem stops at 50 words

  // Simulate cutoff (hits limit)
  {
    "model": "lorem-slow",
    "max_tokens": 100,
    "lorem_max": 150
  }
  // Result: Lorem tries to generate 150 words but cuts off at 100 (stop_reason: "max_tokens")
  ```

**Insomnia Environment Variables:**
- `llm_model`: Default model for non-streaming requests (default: `lorem-fast`)
- `llm_max_tokens`: Max tokens for non-streaming (default: 200)
- `llm_model_streaming`: Model for streaming requests (default: `lorem-slow`)
- `llm_max_tokens_streaming`: Max tokens for streaming (default: 500)

### Documentation

- **Start here:** `_docs/technical/llm/streaming/README.md` (navigation hub)
- Architecture: `_docs/technical/backend/architecture/streaming-architecture.md`
- Block types: `_docs/technical/llm/streaming/block-types-reference.md`
- Race conditions: `_docs/technical/llm/streaming/race-conditions.md`
- Library: `meridian-stream-go/README.md`

## Tool Auto-Mapping

The backend automatically maps minimal tool definitions to provider-specific implementations.

### Usage Patterns

**Minimal definition (auto-map to built-in):**
```json
{
  "tools": [
    {"name": "web_search"},
    {"name": "bash"},
    {"name": "text_editor"}
  ]
}
```
→ Library resolves to provider's built-in tools (e.g., Anthropic's `web_search_20250305`)

**Custom tool (bypass auto-mapping):**
```json
{
  "tools": [
    {
      "type": "custom",
      "name": "make_file",
      "description": "Write text to a file",
      "input_schema": {
        "type": "object",
        "properties": {
          "filename": {"type": "string"},
          "content": {"type": "string"}
        }
      }
    }
  ]
}
```
→ Used as-is, no mapping (user-provided custom tool)

**Mix both:**
```json
{
  "tools": [
    {"name": "web_search"},
    {"type": "custom", "name": "my_tool", "description": "...", "input_schema": {...}}
  ]
}
```
→ First tool auto-maps, second bypasses

### Supported Built-in Tools

- `web_search` (or `search`) - Web search (server-executed)
- `text_editor` (or `file_edit`) - Text editor (client-executed)
- `bash` (or `code_exec`) - Bash command execution (client-executed)

### Detection Logic

```
if tool.Type == "custom":
    → Pass through as-is (user-provided custom tool)
elif tool has only Name (missing Category/ExecutionSide/Config):
    → Auto-map to built-in using MapToolByName()
else:
    → Pass through as-is (already fully defined)
```

**Implementation:** See `backend/internal/service/llm/adapters/conversion.go:convertTools()`

### Testing Submodule Examples

The submodules have their own Makefiles for testing:

```bash
# Test meridian-stream-go examples
cd meridian-stream-go
make run-simple              # Basic streaming
make run-nethttp-sse         # SSE with net/http
make run-catchup-test        # Reconnection/catchup
make clean                   # Remove binaries

# Test meridian-llm-go examples
cd meridian-llm-go
make run-lorem-streaming     # Mock provider (no API key)
make run-anthropic-streaming # Real Claude API
make clean
```

See submodule READMEs for complete documentation:
- `meridian-stream-go/README.md`
- `meridian-llm-go/README.md`
- `meridian-llm-go/examples/README.md`
