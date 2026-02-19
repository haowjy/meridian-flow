---
detail: standard
audience: developer
---

# Database Connections

## Problem

Supabase provides two connection types. Using the wrong one causes "prepared statement already exists" errors.

## Connection Types

| Type | Port | For | Auto-Configuration |
|------|------|-----|-------------------|
| Pooled (PgBouncer) | 6543 | Dev and production | `QueryExecModeCacheDescribe` (no prepared statements) |
| Direct | 5432 | Static-IP deployments | Prepared statements (better performance) |

### Pooled Connection (Port 6543)

Uses Supabase's PgBouncer connection pooler. Works from any IP. PgBouncer's transaction mode historically didn't support prepared statements; Supabase's pooler still requires cached describe or simple protocol mode.

**When to use:** Development and production (any deployment without static IP)

**Connection string:**
```
postgresql://...@...pooler.supabase.com:6543/postgres
```

**Auto-configuration:** Port 6543 is automatically detected and configures `QueryExecModeCacheDescribe` to avoid prepared statements.

**Explicit override (optional):**
```
postgresql://...@...pooler.supabase.com:6543/postgres?default_query_exec_mode=simple_protocol
```

### Direct Connection (Port 5432)

Bypasses PgBouncer, connects directly to PostgreSQL. Requires IP whitelisting but supports full PostgreSQL features.

**When to use:** Deployments with static IP (optional, for prepared statement performance)

**Connection string:**
```
postgresql://...@db.your-project.supabase.co:5432/postgres
```

## Setup

**Development** (`.env`):
```env
# Simple - auto-detected
SUPABASE_DB_URL=postgresql://...pooler.supabase.com:6543/postgres

# Or explicit (optional)
SUPABASE_DB_URL=postgresql://...pooler.supabase.com:6543/postgres?default_query_exec_mode=simple_protocol
```

**Production** (Railway/Vercel):
```env
# Use pooled connection (works with dynamic IPs)
SUPABASE_DB_URL=postgresql://...pooler.supabase.com:6543/postgres
```

> **Optional:** If your deployment has a static IP, you can use port 5432 for prepared statement performance. Whitelist the IP in Supabase Dashboard -> Database -> Database settings.

## Environment-Based Table Names

Tables use environment-specific prefixes to isolate dev/test/prod data in the same database.

### How It Works

```mermaid
graph TB
    ENV["ENVIRONMENT variable"] --> CHECK{Value?}
    CHECK -->|"dev"| DEV["Prefix: 'dev_'"]
    CHECK -->|"test"| TEST["Prefix: 'test_'"]
    CHECK -->|"prod"| PROD["Prefix: 'prod_'"]

    DEV --> TABLES1["dev_projects<br/>dev_folders<br/>dev_documents"]
    TEST --> TABLES2["test_projects<br/>test_folders<br/>test_documents"]
    PROD --> TABLES3["prod_projects<br/>prod_folders<br/>prod_documents"]

    style DEV fill:#2d7d2d
    style TEST fill:#9d7d2d
    style PROD fill:#7d2d2d
```

### Dynamic Table Names in Code

Our code uses `fmt.Sprintf` for dynamic table names:
```go
query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", tables.Documents)
```

This works with prepared statements because:
- `fmt.Sprintf` runs **before** database sees the query
- Each environment gets different SQL -> different prepared statements
- `dev_documents` and `test_documents` have separate statement caches

**Implementation:** `internal/repository/postgres/connection.go:15-27`

**Example:**
```go
// Environment: dev
tables.Documents = "dev_documents"
query = "SELECT * FROM dev_documents WHERE id = $1"  // Statement cache: dev_documents_select

// Environment: test
tables.Documents = "test_documents"
query = "SELECT * FROM test_documents WHERE id = $1"  // Statement cache: test_documents_select
// No conflict!
```

See `internal/repository/postgres/document.go:29-33` for usage examples.

## Troubleshooting

**Error:** `prepared statement "stmtcache_xxx" already exists`

**Causes:**
1. Using port 6543 without auto-detection working (check `connection.go`)
2. Explicitly overriding to use prepared statements with PgBouncer
3. Cached prepared statements on Supabase (requires project restart)

**Fixes:**
1. Ensure connection uses port 6543 (auto-configures simple protocol)
2. Or explicitly add: `?default_query_exec_mode=simple_protocol`
3. If error persists after config fix, restart Supabase project in dashboard

See `internal/repository/postgres/connection.go` for hybrid auto-detection logic.

## References

Implementation: `internal/repository/postgres/connection.go`
Environment setup: `backend/ENVIRONMENTS.md`
Supabase docs: https://supabase.com/docs/guides/database/connection-pooling
