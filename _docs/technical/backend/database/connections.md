---
detail: minimal
audience: developer
---

# Database Connections

## Problem

Supabase's PgBouncer pooler (port 6543) does not support prepared statements, causing "prepared statement already exists" errors.

## Solution

Auto-detect port 6543 and use `QueryExecModeCacheDescribe` (caches descriptions, not prepared statements). If the user sets `default_query_exec_mode` in the connection string, that takes precedence.

Do NOT use `simple_protocol` -- it cannot encode `map[string]interface{}` to JSONB.

## Pool Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_MAX_CONNS` | 25 | Maximum connections |
| `DB_MIN_CONNS` | 5 | Minimum idle connections |

## Implementation

See `internal/repository/postgres/connection.go`
