# Meridian Backend

Go REST API for the Meridian file management system.

## Quick Start

**Get running in 5 minutes:** See [QUICKSTART.md](QUICKSTART.md)

## Tech Stack

- **Language:** Go 1.25.4
- **HTTP:** Go standard library `net/http`
- **Database:** PostgreSQL via [Supabase](https://supabase.com/)
- **Driver:** pgx v5 (native PostgreSQL)
- **Architecture:** Clean Architecture (Handler → Service → Repository)

## Features

- ✅ REST API (Projects, Folders, Documents)
- ✅ Hierarchical folder structure
- ✅ Markdown content storage
- ✅ Word counting
- ✅ Path-based document creation
- ✅ Bulk import (zip files; folder path from directories)
- ✅ Environment-based table prefixes (dev/test/prod isolation)
- ✅ CORS configured
- ✅ Structured logging
- ✅ LLM integration - Anthropic (Claude), OpenRouter (multi-provider proxy)
- ✅ Real-time streaming - SSE with catchup for reconnections

## LLM Providers

**Working:** Anthropic, OpenRouter
**Planned:** OpenAI, Google/Gemini

**Configuration:** Add API keys to `.env`:
```env
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
```

**See:** [LLM Integration Guide](../_docs/technical/backend/llm-integration.md), [Provider Routing](../_docs/technical/backend/provider-routing.md)

## Project Structure

```
backend/
├── cmd/
│   ├── server/main.go      # Entry point
│   └── seed/main.go        # Database seeder
├── internal/
│   ├── domain/             # Interfaces + models
│   ├── handler/            # HTTP handlers (net/http)
│   ├── service/            # Business logic
│   ├── repository/         # Data access (PostgreSQL)
│   ├── middleware/         # HTTP middleware
│   └── config/             # Configuration
├── schema.sql              # Database schema
├── QUICKSTART.md           # 5-minute setup guide
├── CLAUDE.md               # Development commands
└── .ENVIRONMENTS.md        # Environment quick reference
```

## Development

### Commands

See [CLAUDE.md](CLAUDE.md) for full command reference.

```bash
make run          # Start server
make dev          # Start with hot reload (requires air)
make build        # Build binary
make test         # Run tests
make seed         # Seed test data
make seed-fresh   # Drop tables + seed
```

### API Testing

**Insomnia collections:** 5 focused test suites in `tests/insomnia/`
- `00-health.json`, `01-file-system-crud.json`, `02-file-system-import.json`, `03-file-system-advanced.json`, `04-chat.json`
- See `tests/insomnia/README.md` for details

**Manual testing:**
```bash
curl http://localhost:8080/health
curl http://localhost:8080/api/projects
curl http://localhost:8080/api/projects/{ID}/tree
```

See [tests/README.md](tests/README.md) for details.

## Database Migrations

**Hybrid approach:** Goose for dev, manual script for test/prod.

### Development (Dev Environment)

Use **goose** via Makefile commands:

```bash
make migrate-up        # Apply pending migrations
make migrate-down      # Rollback last migration
make migrate-status    # Show migration status
make seed-fresh        # Drop all + migrate + seed
```

**Benefits:**
- Tracks which migrations have run (`goose_db_version` table)
- Prevents re-running migrations
- Supports rollback for iteration
- Incremental updates when adding new migrations

**Use cases:**
- Day-to-day development
- Testing schema changes
- Adding new migration files

### Test/Production Environments

Use **manual script** for one-time environment setup:

```bash
# Interactive mode (recommended)
./scripts/migrate-prefix.sh
# Shows menu → select test/prod → enter DB URL → migrates

# Direct mode (for automation)
./scripts/migrate-prefix.sh test_
./scripts/migrate-prefix.sh prod_
```

**Why manual?** Goose can't handle multiple table prefixes (dev_, test_, prod_) in the same database.

**Benefits:**
- Prompts for DB URL (safer than reusing .env)
- Interactive safety confirmations
- Flexible for any prefix/database combination

**See:** [scripts/README.md](../scripts/README.md#migrate-prefixsh) for detailed usage.

### When to Use Which

| Scenario | Tool | Command |
|----------|------|---------|
| Daily dev work | Goose | `make seed-fresh` |
| Testing schema changes | Goose | `make migrate-down` + `make migrate-up` |
| Setting up Docker test env | Manual script | `./scripts/migrate-prefix.sh test_` |
| Deploying to production | Manual script | `./scripts/migrate-prefix.sh prod_` |
| Adding new migration | Goose | `make migrate-create name="add_feature"` |

## Documentation

### Quick References (in `/backend/`)

- [QUICKSTART.md](QUICKSTART.md) - 5-minute setup
- [CLAUDE.md](CLAUDE.md) - Development commands
- [.ENVIRONMENTS.md](.ENVIRONMENTS.md) - Environment configuration

### Technical Documentation (in `/_docs/technical/backend/`)

**Start here:** [Backend Documentation Index](../_docs/technical/backend/README.md)

**Key docs:**
- [Architecture Overview](../_docs/technical/backend/architecture/overview.md) - Clean Architecture explained
- [API Contracts](../_docs/technical/backend/api/contracts.md) - Complete API reference
- [Database Schema](../_docs/technical/backend/database/schema.md) - Schema + ER diagram
- [Database Connections](../_docs/technical/backend/database/connections.md) - Connection setup
- [Debugging Guide](../_docs/technical/backend/development/debugging.md) - Troubleshooting

## Environment Setup

**Development:**
```env
ENVIRONMENT=dev
SUPABASE_DB_URL=postgresql://...@...pooler.supabase.com:6543/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your-key-here
PORT=8080
CORS_ORIGINS=http://localhost:3000
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

**Details:** See `.env.example` for development and `.env.production.example` for deployment.

## Deployment

**Platform:** Railway (backend) + Vercel (frontend)

**Environment variables required:**
- `ENVIRONMENT=prod`
- `SUPABASE_DB_URL` - Transaction mode connection (port 6543)
- `SUPABASE_URL` - For JWT verification
- `SUPABASE_KEY` - Service role secret
- `CORS_ORIGINS` - Frontend URLs (comma-separated)
- `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` - LLM provider
- `DEBUG=false` - Disable debug features in production

**Note:** Railway auto-injects `PORT` - do not set manually.

**Setup guide:** See `_docs/technical/deployment.md`

## Troubleshooting

**Common issues:** See [Debugging Guide](../_docs/technical/backend/development/debugging.md)

**Quick fixes:**
- Database connection errors → Check `SUPABASE_DB_URL` and Supabase dashboard
- "Prepared statement already exists" → Ensure using port 6543 (development)
- Seeding fails → Run `make seed-fresh`
- CORS errors → Add frontend URL to `CORS_ORIGINS`

## License

MIT
