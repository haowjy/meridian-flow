# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Meridian is a document management system for creative writers, starting with fiction writers who manage 100+ chapter web serials. For product details, see `_docs/high-level/1-overview.md`.

**Current Status:**
- ✅ Backend (Go + Fiber + PostgreSQL): Fully implemented
- 🚧 Frontend (Next.js + TipTap): Not yet started

## Repository Navigation

```
backend/
├── cmd/server/main.go              # Entry point, routing, middleware setup
├── internal/
│   ├── config/                     # Environment configuration
│   ├── database/                   # DB connection, CRUD operations
│   │   ├── database.go             # Connection wrapper with table prefix support
│   │   ├── table_names.go          # Dynamic table naming (dev_/test_/prod_)
│   │   └── documents.go            # Document queries
│   ├── handlers/                   # HTTP request handlers (Fiber)
│   ├── middleware/                 # Auth stub, error handling
│   ├── models/                     # Document, Project structs
│   └── utils/
│       ├── tiptap_converter.go     # TipTap JSON → Markdown conversion
│       ├── word_counter.go         # Word counting from Markdown
│       └── path_validator.go       # Document path validation
└── schema.sql                      # Database schema (run in Supabase)

_docs/                              # Product documentation
├── README.md                       # Documentation structure guide
├── high-level/                     # Product vision, MVP specs
└── technical/                      # Architecture decisions
```

## Development Commands

### Backend

```bash
# Navigate to backend
cd backend

# First time setup
cp .env.example .env
# Edit .env with Supabase credentials
go mod download

# Run schema in Supabase SQL Editor (one-time)
# Copy contents of schema.sql → Supabase Dashboard → SQL Editor → Run

# Start server (development)
go run ./cmd/server/main.go

# Build binary
go build -o bin/server ./cmd/server
# or
make build

# Run tests
go test ./...

# Format code
go fmt ./...

# Hot reload (requires air: go install github.com/cosmtrek/air@latest)
make dev
```

### Database Setup

1. Create Supabase project at supabase.com
2. Go to SQL Editor in Supabase dashboard
3. Run `backend/schema.sql` to create `dev_projects` and `dev_documents` tables
4. Get database connection string from Settings → Database
5. Configure `.env` with `SUPABASE_DB_URL` (this is all you need for Phase 1!)

### API Testing

**Recommended:** Import `backend/tests/insomnia-collection.json` to Insomnia for easy testing.

**Alternative:** Use curl commands from `_docs/technical/backend/api-testing-comprehensive.md`

```bash
# Health check
curl http://localhost:8080/health

# Create document
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{
    "path": "Test Document",
    "content_tiptap": {
      "type": "doc",
      "content": [{
        "type": "paragraph",
        "content": [{"type": "text", "text": "Hello world!"}]
      }]
    }
  }'

# List all documents
curl http://localhost:8080/api/documents

# Get document by ID
curl http://localhost:8080/api/documents/{id}

# Update document
curl -X PUT http://localhost:8080/api/documents/{id} \
  -H "Content-Type: application/json" \
  -d '{"path": "Updated Title"}'

# Delete document
curl -X DELETE http://localhost:8080/api/documents/{id}
```

## Important Coding Conventions

### Always Use Dynamic Table Names

The backend uses environment-based table prefixes. **Never hardcode table names.**

```go
// ✅ Correct - uses dynamic table names
query := fmt.Sprintf("SELECT * FROM %s WHERE project_id = $1", db.Tables.Documents)

// ❌ Wrong - hardcoded table name
query := "SELECT * FROM documents WHERE project_id = $1"
```

**Why:** `ENVIRONMENT` variable determines table prefix:
- `dev` → `dev_projects`, `dev_documents`
- `test` → `test_projects`, `test_documents`
- `prod` → `prod_projects`, `prod_documents`

See `backend/ENVIRONMENTS.md` for complete setup guide.

### Adding New Endpoints

1. Define handler in `internal/handlers/`
2. Register route in `cmd/server/main.go`
3. Use `db.Tables.Documents` or `db.Tables.Projects` for table names
4. Return errors with `fiber.NewError(status, message)` for proper error handling

### TipTap JSON Structure

When handling document creation/updates, TipTap JSON must have this structure:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [{"type": "text", "text": "..."}]
    }
  ]
}
```

Use `utils.ConvertTipTapToMarkdown()` to generate Markdown from TipTap JSON. Both formats must be saved together.

### Document Path Validation

Use `utils.ValidatePath()` before saving documents:
- Max 500 characters
- Alphanumeric + spaces/hyphens/underscores/slashes
- No leading/trailing slashes
- No consecutive slashes

### Error Handling

Use Fiber's error handling:

```go
if err != nil {
    return fiber.NewError(fiber.StatusBadRequest, "Invalid input")
}
```

The error middleware will format responses consistently.

## Key Architecture Patterns

### Environment-Based Table Prefixing

**How it affects your code:**
- All database queries must use `db.Tables.Projects` and `db.Tables.Documents`
- Table prefix is determined at startup based on `ENVIRONMENT` variable
- Allows single database with isolated environments OR separate databases

**When writing queries:**
```go
// Get the DB instance from handler context
query := fmt.Sprintf(`
    SELECT * FROM %s
    WHERE id = $1 AND project_id = $2
`, db.Tables.Documents)
```

### Dual Content Storage

**How it affects your code:**
- Documents store **both** TipTap JSON (JSONB) and Markdown (TEXT)
- Markdown is auto-generated from TipTap JSON on every save
- Word count is calculated from Markdown

**When creating/updating documents:**
```go
// 1. Receive TipTap JSON from frontend
// 2. Convert to Markdown
markdown, err := utils.ConvertTipTapToMarkdown(tiptapJSON)
// 3. Count words
wordCount := utils.CountWords(markdown)
// 4. Save both TipTap JSON and Markdown
```

### Phase 1 Auth Stub

**How it affects your code:**
- Real authentication not yet implemented
- Uses hardcoded `TEST_USER_ID` and `TEST_PROJECT_ID` from environment
- Auth middleware injects test user ID into context
- `EnsureTestProject()` creates default project on startup

**When accessing user/project:**
```go
// User ID is injected by middleware
userID := c.Locals("userID").(string)

// Project ID comes from TEST_PROJECT_ID
// Don't build complex multi-project logic yet
```

## Environment Variables

Required in `.env`:
- `PORT` - Server port (default: 8080)
- `ENVIRONMENT` - Environment name: dev/test/prod (determines table prefix)
- `SUPABASE_DB_URL` - PostgreSQL connection string
- `SUPABASE_URL` - Supabase project URL (optional in Phase 1, for future features)
- `SUPABASE_KEY` - Supabase secret key in `sb_secret_...` format (optional in Phase 1, for future features)
  - ⚠️ Use NEW secret key format (`sb_secret_...`), NOT legacy JWT (`eyJhbGc...`)
- `CORS_ORIGINS` - Allowed origins (comma-separated)
- `TEST_USER_ID` - Phase 1 stub user ID
- `TEST_PROJECT_ID` - Phase 1 stub project ID

Optional:
- `TABLE_PREFIX` - Override automatic prefix (if not using dev/test/prod)

## Common Gotchas

1. **Always use `db.Tables.*` for table names** - Never hardcode table names in queries
2. **Run schema.sql in Supabase** - Just run it once in SQL Editor, that's it (no complex migrations for Phase 1)
3. **Environment variable for table prefix** - `ENVIRONMENT=dev` creates `dev_*` tables (only accepts: dev, test, prod)
4. **TipTap JSON structure** - Must have `{"type": "doc", "content": [...]}`
5. **Document paths** - No leading/trailing slashes, no consecutive slashes
6. **CORS origins** - Must match frontend URL for local development
7. **Supabase keys** - Use NEW format (`sb_secret_...`), not legacy JWT (`eyJhbGc...`)
8. **Phase 1 only needs SUPABASE_DB_URL** - API keys are optional (for future)

## Documentation

- **Product documentation**: See `_docs/` directory
- **Documentation structure**: See `_docs/README.md` for conventions
- **Product vision**: See `_docs/high-level/1-overview.md`
- **MVP specification**: See `_docs/high-level/2-mvp.md`
- **Technical architecture**: See `_docs/technical/` (when created)

## Deployment

- **Backend**: Railway (configured in `railway.json`)
- **Database**: Supabase (PostgreSQL)
- **Frontend** (future): Vercel

Set environment variables in Railway dashboard matching `.env` structure.
