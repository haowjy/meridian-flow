# CLAUDE.md

## Project Overview

Meridian is an agentic writing platform for fiction writers managing 100+ chapter web serials, inclusive of any kind of writer.

See `_docs/high-level/1-overview.md` for product details.

No real users or user data. No backwards compatibility needed. Schema can change freely.

## Product Philosophy

**Writer-first**: every feature, UI element, and AI interaction should support the writing process.

See `frontend/CLAUDE.md` for UI-specific implementation.

## Development Principles

### SOLID

- **SRP**: One file = one purpose. One store = one domain. Split large components.
- **OCP**: Use registries/factories for extensibility (see ToolRegistry, BlockRenderer)
- **LSP**: All implementations must be substitutable for their interfaces
- **ISP**: Split large interfaces (Reader vs Writer, Metadata vs CRUD)
- **DIP**: Depend on interfaces, not concrete types (especially for external services)

### Code Quality

- **Comment the "weird" and the "why"** -- if it needs a guard, comment why. If it prevents a race, explain the race.
- **Plan before implementing** -- anything beyond a few lines needs an approved plan. Write plans as markdown in `_docs/plans/`.
- **Plan for extensibility**

### Before Writing New Code

1. **Search for existing patterns** -- before implementing, search for similar implementations
2. **Reuse over recreate** -- if a pattern exists, use it or extend it
3. **Check shared utilities** -- before writing a helper, search for existing ones
4. **When patterns diverge, consolidate** -- 2+ implementations of the same thing? Refactor to one.

## Where to Find Things

| Area | Location |
|------|----------|
| Backend instructions | `backend/CLAUDE.md` |
| Frontend instructions | `frontend/CLAUDE.md` |
| Documentation rules | `_docs/CLAUDE.md` |
| Technical architecture docs | `_docs/technical/` |
| Feature docs | `_docs/features/` |
| Plans | `_docs/plans/` |
| Agent profiles | `.claude/agents/` |

## Dev Environment

The dev environment uses tmux with worktree-aware port allocation.

**First-time setup:**
1. `cp backend/.env.example backend/.env` -- edit with Supabase/API credentials
2. `cp frontend/.env.example frontend/.env.local` -- set `VITE_API_URL` to match backend port
3. `cp scripts/get-token.sh.example scripts/get-token.sh && chmod +x scripts/get-token.sh`
4. `./scripts/dev/setup.sh` -- creates tmux session with backend + frontend

**Port allocation:**
- Backend: `8080 + hash(directory_name) % 100` (per worktree)
- Frontend: always `3000`
- Check your port: `source scripts/dev/lib.sh && echo $BACKEND_PORT`
- Override: create `.dev-ports` (gitignored) in repo root

**Daily usage:**
- Start: `./scripts/dev/setup.sh`
- Restart backend: `./scripts/restart-server.sh`
- Attach: `tmux attach -t <session_name>`

**Agent permissions:**
- Can restart backend via `./scripts/restart-server.sh`
- Can run curl commands to test APIs
- Can run `./scripts/get-token.sh` to refresh `ACCESS_TOKEN` for smoke tests

## Build and Test

### Frontend
- `pnpm` (not npm)
- `pnpm run lint` after changes
- `pnpm run format 2>&1 | grep -v "unchanged"` after Tailwind/CSS changes

### Backend
- See `backend/CLAUDE.md` for Go commands

### Smoke Testing
- See `backend/CLAUDE.md` -> "Smoke Testing"
- See `/scratchpad` skill for scratch/smoke file conventions

### Documentation
- Read `_docs/CLAUDE.md` before updating docs
- Prefer diagrams over words, point to code locations
- No emojis
- Run `.claude/skills/documenting/check-md-links.sh` to verify links
- When adding/updating a feature: update `_docs/features/<feature-name>/`, then commit code + docs together

## Git Conventions

- Commit after each testable state
- Confirm with user before committing if they are in the loop
- Follow repository's commit message style

## Deployment

| Component | Platform |
|-----------|----------|
| Backend | Railway |
| Database | Supabase (PostgreSQL) |
| Frontend | Vercel |

See `backend/CLAUDE.md` for deployment details.

## Refactoring Backlog

Tracked in `_docs/future/refactoring-backlog.md`. Review before starting related work.
