# Database Seed Script (Go)

## Purpose

This Go-based seed script is primarily for **schema management** (creating/dropping tables). For seeding actual documents, use the shell script in `scripts/seed.sh` instead.

## Usage

```bash
# Seed documents (adds data, doesn't delete)
go run ./cmd/seed/main.go

# Clear all data (keep schema)
go run ./cmd/seed/main.go --clear-data

# Drop and recreate tables + seed documents
go run ./cmd/seed/main.go --drop-tables

# Drop and recreate tables only (no documents)
go run ./cmd/seed/main.go --drop-tables --schema-only

# Schema only (ensure tables exist)
go run ./cmd/seed/main.go --schema-only
```

⚠️ **Production Safety:** `--drop-tables` and `--clear-data` are BLOCKED in production (`ENVIRONMENT=prod`). Normal seeding (adding data) is still allowed.

## Recommended Workflow

**For seeding documents, use the shell script instead:**

```bash
# This is better - uses API and reads from JSON files
./scripts/seed.sh --drop-tables
```

See `scripts/README.md` for details.

## Why Two Seeding Approaches?

### Go Seed Script (`cmd/seed/main.go`)
- ✅ Good for schema operations (CREATE TABLE, DROP TABLE)
- ✅ Uses `SimpleProtocol` mode to avoid prepared statement conflicts
- ❌ JSONB encoding issues when seeding documents
- ❌ Seed data hardcoded in Go

### Shell Script (`scripts/seed.sh`)
- ✅ Uses API (tests actual code path)
- ✅ No JSONB encoding issues (uses prepared statements)
- ✅ Seed data in JSON files (easy to edit)
- ✅ Automatic folder creation from paths
- ❌ Requires server to be running

## Technical Details

This script uses `CreateConnectionPoolForSchemaOps()` which:
- Uses SimpleProtocol query execution mode
- Prevents prepared statement conflicts with dynamic table names
- Cannot properly encode `map[string]interface{}` to JSONB

The server uses `CreateConnectionPool()` which:
- Uses prepared statements (better performance)
- Properly encodes JSONB data
- Safe for CRUD operations with dynamic table names
