# Meridian

Agentic writing platform for fiction writers managing 100+ chapter web serials. No real users or user data. No backwards compatibility needed. Schema can change freely.

See `_docs/high-level/1-overview.md` for product details.

## Development Principles

- **SOLID**: SRP (one file = one purpose), OCP (registries/factories), ISP (Reader vs Writer splits), DIP (depend on interfaces)
- **Comment the "weird" and the "why"** -- guards, races, non-obvious invariants
- **Search before implementing** -- reuse existing patterns, check shared utilities, consolidate divergences
- **Plan before implementing** -- anything beyond a few lines needs a plan in `_docs/plans/`

## Where to Find Things

| Area | Location |
|------|----------|
| Backend | `backend/AGENTS.md` |
| Frontend | `frontend/CLAUDE.md` |
| Frontend v2 | `frontend-v2/CLAUDE.md` |
| Documentation rules | `_docs/CLAUDE.md` |
| Technical docs | `_docs/technical/` |
| Feature docs | `_docs/features/` |
| Plans | `_docs/plans/` |
| Agent profiles | `.claude/agents/` |
| Refactoring backlog | `_docs/future/refactoring-backlog.md` |

## Dev Environment

Tmux with worktree-aware port allocation. Backend port: `8080 + hash(dir) % 100`. Frontend: always `3000`.

**First-time setup:**
1. `./scripts/dev/supabase-start.sh` -- starts local Supabase, patches `.env`, runs migrations
2. `cp scripts/get-token.sh.example scripts/get-token.sh && chmod +x scripts/get-token.sh`
3. `./scripts/dev/setup.sh` -- creates tmux session with backend + frontend

**Daily:** `./scripts/dev/setup.sh` (auto-starts Supabase). Restart backend: `./scripts/restart-server.sh`.

## Build and Test

| Stack | Commands |
|-------|----------|
| Frontend | `pnpm` (not npm). `pnpm run lint`, `pnpm run format` |
| Backend | See `backend/AGENTS.md` |
| Smoke tests | `backend/AGENTS.md` -> "Smoke Testing" |

## Git Conventions

Commit after each testable state. Follow repository commit message style.

## Deployment

| Component | Platform |
|-----------|----------|
| Backend | Railway |
| Database | Supabase (PostgreSQL) |
| Frontend | Vercel |

## Agent Spawning

- `meridian spawn` for delegated work (coding, reviewing, testing, research)
- Harness-native Agent types (`Explore`, `Plan`) for quick lookups
- Harness-native tools (Read, Grep, Glob, Bash, Edit, Write) for quick operations
