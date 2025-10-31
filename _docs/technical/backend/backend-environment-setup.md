---
title: Backend Environment Setup
description: How environment-based table prefixing works and deployment strategies
created_at: 2025-10-31
updated_at: 2025-10-31
author: Jimmy Yao
category: technical
tracked: true
---

# Backend Environment Setup

The Meridian backend uses **automatic table prefixing** to isolate data across development, test, and production environments.

## How It Works

Set `ENVIRONMENT` variable → Backend automatically prefixes all table names:

| Environment | Tables Created |
|-------------|----------------|
| `dev` | `dev_projects`, `dev_documents` |
| `test` | `test_projects`, `test_documents` |
| `prod` | `prod_projects`, `prod_documents` |

## Setup Strategies

### Strategy 1: Single Database (Recommended for Phase 1)

**Use one Supabase database** for all environments.

**Setup:**
1. Run `backend/schema.sql` in Supabase SQL Editor (creates `dev_*` tables)
2. Set `ENVIRONMENT=dev` in `.env`
3. When you need test/prod, copy schema.sql and adjust table names

**Pros:**
- ✅ Simple - one database to manage
- ✅ Free tier friendly
- ✅ Easy environment switching (just change `.env`)

**Cons:**
- ⚠️ Less isolation between environments
- ⚠️ Shared rate limits

### Strategy 2: Separate Databases (Production Ready)

**Use separate Supabase projects** for each environment.

**Setup:**
1. Create 3 Supabase projects: `meridian-dev`, `meridian-test`, `meridian-prod`
2. Run schema in each with appropriate prefix
3. Use different `.env` files or environment variables per environment

**Pros:**
- ✅ Complete isolation
- ✅ Independent rate limits
- ✅ Can't accidentally affect other environments

**Cons:**
- ⚠️ More databases to manage
- ⚠️ Higher cost

## Configuration

### Automatic Prefix

```env
ENVIRONMENT=dev   # → uses dev_*
ENVIRONMENT=test  # → uses test_*
ENVIRONMENT=prod  # → uses prod_*
```

Only these three values are accepted. Backend automatically maps to table prefix.

### Manual Override

```env
ENVIRONMENT=dev
TABLE_PREFIX=custom_  # Override if needed
```

## Implementation Details

### Code Level

All database queries use dynamic table names via `db.Tables.*`:

```go
// ✅ Correct
query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", db.Tables.Documents)

// ❌ Wrong - hardcoded
query := "SELECT * FROM documents WHERE id = $1"
```

The `db.Tables` struct is initialized at startup based on `ENVIRONMENT`.

### Database Level

Schema is simple - same structure for all environments, just different table names:

```sql
-- dev environment
CREATE TABLE dev_projects (...);
CREATE TABLE dev_documents (...);

-- test environment  
CREATE TABLE test_projects (...);
CREATE TABLE test_documents (...);

-- prod environment
CREATE TABLE prod_projects (...);
CREATE TABLE prod_documents (...);
```

## Environment Switching

### Local Development

```bash
# Edit .env
ENVIRONMENT=dev

# Restart server
go run ./cmd/server/main.go

# Server logs confirm:
# Successfully connected to database (table prefix: dev_)
```

### Deployment

Set environment variables in your deployment platform (Railway, etc.):

```env
ENVIRONMENT=prod
SUPABASE_DB_URL=postgresql://...prod-db...
```

## Best Practices

1. **Use `dev` for daily development** - All experimental work goes here
2. **Use `test` for staging/QA** - Test with production-like data
3. **Use `prod` for live users** - Only deploy tested, stable code
4. **Never modify prod directly** - Always test in dev → test → prod
5. **Clean up dev/test periodically** - Delete old test data

## Migration Strategy (Future)

For Phase 1, just run `schema.sql` once. No complex migrations needed.

When you need to change the schema later:
1. Test ALTER statements in `dev` environment
2. Apply to `test` once working
3. Finally apply to `prod`

You can re-run modified `schema.sql` in Phase 1 since there's no production data yet.

## Troubleshooting

### "Table does not exist"

**Cause:** Migration not run for this environment

**Fix:** 
1. Check `ENVIRONMENT` in `.env`
2. Run schema.sql with correct table prefix
3. Restart server

### Wrong environment data

**Cause:** `ENVIRONMENT` variable mismatch

**Fix:**
1. Check `.env` file
2. Look at server startup logs for table prefix
3. Restart server after changing environment

## See Also

- Backend README: `backend/README.md`
- Quick start guide: `backend/QUICKSTART.md`
- Full environment guide: `backend/ENVIRONMENTS.md`

