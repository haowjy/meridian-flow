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
PORT=8080
TEST_USER_ID=00000000-0000-0000-0000-000000000001
TEST_PROJECT_ID=00000000-0000-0000-0000-000000000001
CORS_ORIGINS=http://localhost:3000
```

**Details:** See [.ENVIRONMENTS.md](.ENVIRONMENTS.md) and [database/connections.md](../_docs/technical/backend/database/connections.md)

## Deployment

**Platform:** Railway

**Environment variables required:**
- `PORT`
- `ENVIRONMENT` (prod)
- `SUPABASE_DB_URL` (port 5432 for production)
- `TEST_USER_ID`
- `TEST_PROJECT_ID`
- `CORS_ORIGINS`

**Setup guide:** See [development/deployment.md](../_docs/technical/backend/development/deployment.md) (TBD)

## Phase 1 Notes

**Authentication:** Stubbed with hardcoded test IDs (Phase 1). Real auth in Phase 2.

**Project scope:** Single test project, all operations scoped to `TEST_PROJECT_ID`.

## Troubleshooting

**Common issues:** See [Debugging Guide](../_docs/technical/backend/development/debugging.md)

**Quick fixes:**
- Database connection errors → Check `SUPABASE_DB_URL` and Supabase dashboard
- "Prepared statement already exists" → Ensure using port 6543 (development)
- Seeding fails → Run `make seed-fresh`
- CORS errors → Add frontend URL to `CORS_ORIGINS`

## License

MIT
