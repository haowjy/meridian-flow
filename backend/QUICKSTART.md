# Quick Start Guide

Get the Meridian backend up and running locally using the deployed (cloud) Supabase instance.

All environments share the same Supabase database but are isolated via table prefixes (`dev_`, `test_`, `prod_`).

## Prerequisites

- Go 1.21+
- [goose](https://github.com/pressly/goose) migration tool:
  ```bash
  go install github.com/pressly/goose/v3/cmd/goose@latest
  ```

## Step 1: Configure Backend Environment

```bash
cd backend
cp .env.example .env
```

Edit `.env` with your cloud Supabase credentials:

```env
PORT=8080
ENVIRONMENT=dev

# Cloud Supabase - Transaction mode (port 6543)
# From: Supabase Dashboard -> Settings -> Database -> Connection String -> Transaction mode
SUPABASE_DB_URL=postgresql://postgres.[PROJECT]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres

# Cloud Supabase - API settings
# From: Supabase Dashboard -> Settings -> API
SUPABASE_URL=https://[PROJECT].supabase.co
SUPABASE_KEY=sb_secret_...

CORS_ORIGINS=http://localhost:3000
```

**Port 6543** (transaction pooler) is recommended — no IP whitelisting needed and auto-configures simple protocol.

## Step 2: Configure Frontend Environment

```bash
cd frontend
cp .env.example .env.local
```

Edit `.env.local`:

```env
VITE_SUPABASE_URL=https://[PROJECT].supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_API_URL=http://127.0.0.1:8080
```

## Step 3: Run Migrations

From `backend/`:

```bash
make migrate-up
```

This applies all migration files with the `dev_` table prefix (derived from `ENVIRONMENT=dev`). Migrations use goose's `ENVSUB` feature to substitute `${TABLE_PREFIX}` in SQL.

Check migration status:
```bash
make migrate-status
```

## Step 4: Seed Test Data (Optional)

```bash
make seed
```

This creates a test project with sample documents. See `scripts/README.md` for more seeding options.

## Step 5: Start Services

```bash
# Terminal 1 - Backend
cd backend && make run

# Terminal 2 - Frontend
cd frontend && pnpm install && pnpm run dev
```

## Step 6: Verify

```bash
curl http://localhost:8080/health
```

Expected response:
```json
{
  "status": "ok",
  "time": "2025-..."
}
```

## Key Notes

- All tables are prefixed with `dev_` (e.g., `dev_projects`, `dev_documents`) — completely isolated from `prod_` tables
- Google OAuth callback URLs in Supabase dashboard need to include `http://localhost:3000` for local auth to work
- Port 5432 (direct connection) requires IP whitelisting in Supabase dashboard — use 6543 instead

## Common Commands

```bash
make run              # Start server
make dev              # Start with hot reload (requires air)
make seed             # Seed test data
make seed-fresh       # Drop tables + migrate + seed
make migrate-status   # Check migration status
make migrate-up       # Apply pending migrations
make migrate-down     # Rollback last migration
```

## Troubleshooting

### "Failed to connect to database"

- Verify `SUPABASE_DB_URL` in `.env` is correct
- Ensure you're using port 6543 (transaction pooler)
- Check your Supabase project is active (not paused)

### "prepared statement already exists"

- Ensure using port 6543 (auto-configures simple protocol)
- If error persists, restart the Supabase project in the dashboard

### Tables not found

- Run `make migrate-status` to check if migrations have been applied
- Run `make migrate-up` to apply pending migrations
- Verify `ENVIRONMENT=dev` in `.env` (determines `dev_` prefix)

### Port already in use

Change `PORT` in `.env` (e.g., `8081`).

## Further Reading

- **Environment details**: `ENVIRONMENTS.md`
- **Backend conventions**: `CLAUDE.md`
- **Frontend setup**: `_docs/technical/frontend/setup-quickstart.md`
- **Database connections**: `_docs/technical/backend/database/connections.md`
- **Seeding**: `scripts/README.md`
