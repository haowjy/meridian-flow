# Seeding Database via API

This directory contains shell scripts for seeding the database with sample data.

## Quick Start

```bash
# Seed database (fresh start - drops tables)
./scripts/seed.sh --drop-tables

# Seed database (keep existing data)
./scripts/seed.sh
```

## How It Works

The seed script:
1. **Optionally drops and recreates tables** (if `--drop-tables` flag is provided)
2. **Starts the server** if not already running
3. **Reads JSON files** from `scripts/seed_data/`
4. **Posts documents** to `/api/documents` endpoint
5. **Cleans up** (stops server if it started one)

## Why Use API for Seeding?

**Benefits:**
- ✅ Tests the actual API code path
- ✅ No JSONB encoding issues (uses prepared statements)
- ✅ Easy to add/modify seed data (just edit JSON files)
- ✅ Path resolution works automatically
- ✅ Word counts calculated correctly

**Alternative (Go seed script):**
The old Go-based seed script (`cmd/seed/main.go`) still exists for schema management:
- `go run ./cmd/seed/main.go --drop-tables --schema-only` - Drop/create tables only
- Not recommended for seeding documents (JSONB encoding issues with SimpleProtocol mode)

## Examples

```bash
# Fresh start with sample data
./scripts/seed.sh --drop-tables

# Add more data without clearing existing
./scripts/seed.sh

# Check if server is running first (script auto-starts if needed)
curl http://localhost:8080/health
```
