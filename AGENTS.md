# Meridian

Agentic writing platform for fiction writers managing 100+ chapter web serials. No real users or user data. No backwards compatibility needed. Schema can change freely.

See `$MERIDIAN_CONTEXT_KB_DIR/wiki/product/high-level/1-overview.md` for product details.

## v3 Full-Stack Rebuild (active)

Ground-up rebuild -- frontend AND backend. Backend rewrites from Go to TypeScript. Design package lives in the active work item directory (`meridian work current`).

Key decisions: TypeScript backend (canonical Yjs, no hashline port), Milkdown (ProseMirror), Y.XmlFragment, agent definitions replace skills, credits-only billing gate, linear turns, Drizzle ORM.

## Where to Find Things

| Area | Location |
|------|----------|
| Backend (Go, current) | `backend/AGENTS.md` |
| Frontend v1 (production) | `frontend/AGENTS.md` |
| Frontend v2 (h/collab) | `frontend-v2/AGENTS.md` |
| v3 Design | Work item dir (`meridian work current`) |
| Plans | `$MERIDIAN_CONTEXT_KB_DIR/plans/` |
| Knowledge base | `$MERIDIAN_CONTEXT_KB_DIR` (`meridian context kb`) |
| Agent profiles | `.claude/agents/` |
| Smoke tests | `.meridian/fs/smoke/` -- manual edge case tests with toy clients |

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
| WS edge case smoke tests | `.meridian/fs/smoke/websocket/AGENTS.md` -- toy client + manual test scripts |

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
