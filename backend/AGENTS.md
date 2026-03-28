# Backend

Go backend using Clean Architecture with domain-oriented modules. For project-wide info, see root `AGENTS.md`.

## Commands

```bash
make run          # Start server
make dev          # Hot reload (requires air)
make build        # Build binary
make test         # Run tests
make migrate-up   # Apply pending DB migrations
make seed         # Seed via API
make seed-fresh   # Drop tables + seed
make seed-clear   # Clear data (keep schema) -- BLOCKED in prod
```

## Server Management

- Restart: `./scripts/restart-server.sh`
- Health: `curl http://localhost:$PORT/health`
- Token: `./scripts/get-token.sh` -- refreshes `ACCESS_TOKEN` in root `.env`
- Authenticated curl: `curl -H "Authorization: Bearer $(grep '^ACCESS_TOKEN=' .env | cut -d= -f2-)" http://localhost:$PORT/api/...`
- Smoke scripts: `tmp/` at repo root (gitignored). See `tmp/README.md`.

## Architecture

Domain-oriented modules with 36-line `main.go` (`cmd/server/main.go`):

```
cmd/server/main.go         -> Load config, create infra, create app, run
internal/app/              -> Bootstrap, server, workers, lifecycle
internal/app/domains/      -> Per-domain wiring modules
internal/domain/<domain>/  -> Interfaces + models (one package per domain)
internal/service/          -> Business logic implementations
internal/handler/          -> HTTP layer (net/http)
internal/repository/       -> Data layer (postgres)
internal/config/           -> Config sub-structs (Server, Database, Auth, LLM, Billing, Logging)
```

Domains: `agents`, `auth`, `billing`, `collab`, `docsystem`, `llm`, `skill`, `workitem`, `identifier`. Each has its own `AGENTS.md`.

Technical reference: `.meridian/fs/backend/` (overview + per-area deep dives)

## Critical Conventions

**Dynamic table names** -- always `db.Tables.*`, never hardcode table names. See `internal/repository/postgres/`.

**SQL migrations** -- `backend/migrations/AGENTS.md` for rules. Prefix all tables/indexes/constraints with `${TABLE_PREFIX}`. Lint with `backend/scripts/lint-migrations.sh`.

**Authorization** -- lives in the service layer, not handlers. Services accept `userID` and call `authorizer.CanAccess*` internally. Pattern: `internal/service/docsystem/document.go`.

**Error responses** -- RFC 7807 via `httputil.RespondError()`. See `internal/handler/errors.go`.

## Environment Variables

Required (auto-configured by `supabase-start.sh`):
- `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_KEY`, `ENVIRONMENT` (dev/test/prod), `PORT`

LLM (at least one): `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`

Optional: `LOG_LEVEL`, `LOG_TO_FILE`, `LOG_DIR`, `LLM_STREAM_DEBUG_LOGS`

See `.env.example` for development, `.env.production.example` for deployment.

## Submodule Development

Local dev uses `go.work`. Never use `replace` directives in `go.mod` (breaks Docker). Patch versions for `meridian-llm-go` auto-bumped by post-commit hook.

## Common Issues

- "relation does not exist" -- run `cd backend && make migrate-up` to apply pending migrations
- "prepared statement already exists" -- ensure port 6543 or add `?default_query_exec_mode=simple_protocol`
- Seeding fails -- `make seed-fresh`
- Docker container names -- local Supabase containers are named `supabase_*_backend` (e.g. `supabase_db_backend`), not `supabase-db`

## HTTP Timeouts

ReadTimeout: 15s, WriteTimeout: 0 (SSE streams), IdleTimeout: 60s. See `internal/app/server.go`.
