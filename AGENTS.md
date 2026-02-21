# AGENTS.md

This file provides guidance when working with the code in this repository.

## Project Overview

Meridian is an agentic writing platform for writers, starting with fiction writers who manage 100+ chapter web serials, but being inclusive for any kind of writer.

**Current Status:**
- ✅ Backend (Go + net/http + PostgreSQL): File system complete, Auth complete (JWT/JWKS), Thread/LLM in progress (Anthropic provider working, streaming complete)
- ✅ Frontend (Vite + TanStack Router + CodeMirror): Document editor complete, Thread UI complete

For product details, see `_docs/high-level/1-overview.md`.

## Concepts

- **Plan** — the overall goal document describing what to build
- **Slice** — a self-contained unit of work that ends in a commit. The codebase must be in a working state after each slice. Slices can be large (a cross-cutting refactor is fine) as long as they are self-contained
- **Task** — a small tracked work item within a slice, managed via the built-in TaskCreate/TaskUpdate/TaskList tools. No separate commits or logs needed

## Product Philosophy

**Writer-first**: Meridian exists to serve the writer. Every feature, UI element, and AI interaction should support—not distract from—the writing process.

See `frontend/CLAUDE.md` for UI-specific implementation of this philosophy.

## Guiding Principles for Development

ALWAYS FOLLOW SOLID PRINCIPLES.

### SOLID Quick Reference

- **SRP**: Files should be about <500 lines. One store = one domain. Split large components.
- **OCP**: Use registries/factories for extensibility (see ToolRegistry, BlockRenderer)
- **LSP**: All implementations must be substitutable for their interfaces
- **ISP**: Split large interfaces (Reader vs Writer, Metadata vs CRUD)
- **DIP**: Depend on interfaces, not concrete types (especially for external services)

1. **Start Simple, Stay Simple**
   - Write the simplest thing that could work
   - Add complexity only when necessary
   - Regularly refactor to remove unnecessary complexity
   - Delete dead code — it's easier to clean up now than later

2. **Make Correctness Obvious**
   - Code should make bugs impossible or obvious
   - Use types to prevent invalid states
   - Fail fast and loudly (don't swallow errors)

3. **One Thing At A Time**
   - Don't optimize and add features simultaneously
   - Test each change before moving on
   - Small, incremental changes are easier to debug

4. **Explicit Over Implicit**
   - `hasUserEdit` flag > trying to detect user edits
   - `content !== undefined` > `content` (falsy check)
   - Direct sync > background queue

5. **Design for Debuggability**
   - Clear console logs at key decision points
   - Helper functions to inspect state (`getRetryQueueState()`)
   - Predictable, deterministic behavior

6. **Guard Against Races**
   - Add locks/flags to prevent concurrent execution
   - Use intent flags to coordinate subsystems
   - Cancel stale operations proactively

7. **Treat Empty as Valid**
   - Empty string `""` is valid data
   - Empty array `[]` is valid data
   - Only `undefined`/`null` means "absent"

8. **Comment the "Weird" and the "WHY"**
   - anything that is not obvious, comment why.
   - If it needs a guard, comment why
   - If it prevents a race, explain the race
   - If you had to debug it, future you will too

9. **Keep Documentation Up-to-Date** - Update documentation AFTER finalizing changes. See "Feature Documentation Sync Rule" for feature documentation workflow.

## Before Writing New Code

1. **Search for existing patterns** - Before implementing, search for similar implementations:
   - Hooks: `grep -r "use<Similar>" frontend/src/`
   - Services: Check `backend/internal/service/` for similar business logic
   - Repositories: Check existing repos for query patterns
   - Components: Search `frontend/src/features/` for similar UI patterns

2. **Reuse over recreate** - If a pattern exists, use it. If it's close but not quite right, extend it.

3. **Check shared utilities** - Before writing a helper:
   - Backend: `backend/internal/util/`, domain errors, httputil
   - Frontend: `frontend/src/core/lib/`, shared hooks, UI components

4. **When patterns diverge, consolidate** - If you find 2+ implementations of the same thing, refactor to one.

## Consistency Checklist

Before submitting code, verify:
- [ ] Error handling follows existing patterns (HTTPError, domain errors)
- [ ] Similar code elsewhere? -> Extract shared utility
- [ ] Dialog patterns use shared components (DeleteConfirmationDialog, etc.)
- [ ] Store patterns match existing stores (abort controllers, selectors)
- [ ] API calls follow api.ts conventions

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend**: `frontend/CLAUDE.md` - Caching patterns, store architecture, CodeMirror conventions

### Documentation

- **Features**: `_docs/features/` - Feature status, implementation guides by stack (f-/b-/fb- prefixes)
  - **Overview**: `_docs/features/README.md` - Complete feature inventory with status
  - **Authentication**: `_docs/features/fb-authentication/` - JWT validation, Supabase integration
  - **Document Editor**: `_docs/features/f-document-editor/` - CodeMirror, auto-save, caching
  - **Thread/LLM**: `_docs/features/fb-thread-llm/` - Turn branching, providers, streaming
  - **File System**: `_docs/features/fb-file-system/` - CRUD operations, tree structure
- **Product/high-level**: `_docs/high-level/` - Product vision, MVP specs, user stories
- **Technical details**: `_docs/technical/` - Deep-dive architecture, implementation specifics
  - **Backend**: `_docs/technical/backend/` - Go backend architecture, API design
  - **Frontend**: `_docs/technical/frontend/` - Vite + TanStack Router frontend architecture, patterns
  - **Authentication**: `_docs/technical/auth-overview.md` - Cross-stack auth flow (Supabase)
  - **Streaming/SSE**: `_docs/technical/llm/streaming/` - Real-time LLM responses, block types
- **Documentation structure**: `_docs/README.md` - How docs are organized

**Always check `_docs/features/` first for feature status, then `_docs/technical/` for implementation details.**

## Documentation

Three tiers: **Features** (`_docs/features/`, start here) > **High-Level** (`_docs/high-level/`) > **Technical** (`_docs/technical/`). Minimum content by default — diagrams > words, reference don't duplicate. See `_docs/conventions/documentation-writing-rules.md` for full rules.

**Mermaid diagrams**: Load the `mermaid` skill before writing/editing diagrams. Always validate with `./scripts/check-mermaid.sh <file>` after changes. **Design docs and plans MUST use Mermaid diagrams** for data flows, architecture, and state transitions — diagrams > ASCII art > prose.

### Feature Documentation Sync Rule

**IMPORTANT: When adding or significantly updating a feature, you MUST update the corresponding feature documentation.**

1. Implement the feature/update
2. Update `_docs/features/<feature-name>/` with changes
3. Update status in `_docs/features/README.md` if needed
4. Run `./scripts/check-md-links.sh`
5. Commit code + docs together

## General Conventions

### Dev Environment Setup

The dev environment uses tmux to run backend + frontend in parallel, with worktree-aware port allocation.

**First-time setup:**
1. `cp backend/.env.example backend/.env` — edit with Supabase/API credentials
2. `cp frontend/.env.example frontend/.env.local` — set `VITE_API_URL` to match backend port (see below)
3. `cp scripts/get-token.sh.example scripts/get-token.sh && chmod +x scripts/get-token.sh` — edit credentials
4. `./scripts/dev/setup.sh` — creates tmux session with backend + frontend

**Port allocation:**
- Backend port is computed per worktree: `8080 + hash(directory_name) % 100`
- Frontend port is always `3000`
- The backend port is passed as a Make variable override (`make run-local PORT=<port>`) to take precedence over `backend/.env`
- `frontend/.env.local` must set `VITE_API_URL` to match the backend port for this worktree

Common worktree ports (from `scripts/dev/lib.sh`):

| Worktree | Backend Port |
|----------|-------------|
| meridian | 8140 |
| meridian-agents | 8170 |
| meridian-collab | 8130 |

To check your worktree's port: `source scripts/dev/lib.sh && echo $BACKEND_PORT`

Optional override: create `.dev-ports` (gitignored) in repo root:
```bash
BACKEND_PORT=8081
FRONTEND_PORT=3001
```

**Daily usage:**
- Start: `./scripts/dev/setup.sh` (creates tmux session)
- Restart backend: `./scripts/restart-server.sh`
- Attach: `tmux attach -t <session-name>`
- Session name = repo directory basename (e.g., `meridian-collab`)

**Agent permissions:**
- Claude CAN restart the backend server via: `./scripts/restart-server.sh`
- Claude CAN run curl commands to test APIs
- Claude CAN run `./scripts/get-token.sh` to refresh `ACCESS_TOKEN` in root `.env` before authenticated smoke tests

### Git Commits

- Only commit when user explicitly requests
- Follow repository's commit message style

### Testing

- User runs tests manually or via CI/CD
- Claude can suggest test commands
- Claude can help write/fix tests

### Smoke Testing

Token refresh is agent-authorized. See `backend/CLAUDE.md` -> "Smoke Testing" for full details. See the `scratchpad` skill for scratch/smoke file conventions.

### Long-Running Tasks

For multi-phase plans, use the `/orchestrate` skill interactively. It launches agents via `run-agent.sh` to implement plans autonomously. See the orchestrate plugin's SKILL.md for full details.

**Install:** `/plugin marketplace add jimmyyao/orchestrate` (Claude Code)
**Agent definitions:** `agents/*.md` in the orchestrate plugin — model, tools, prompt per agent.
**Skills:** `*/SKILL.md` under your skills directory — reusable instruction bundles.

### Plan Execution

When a plan file exists (`.claude/plans/*.md` or `_docs/plans/**/*.md`):

- **Multi-slice plans** (3+ slices or cross-cutting changes): Execute via `/orchestrate <plan-file>`. Never implement multi-slice plans directly.
- **Single-slice plans**: Implement directly, following the plan's scope and acceptance criteria.
- **Check for in-progress orchestrations**: Read `.claude/skills/orchestrate/.session/plans/` for handoff files before starting fresh.

### Agent Preferences

**Prefer Codex (`research-codex`) for most subagent tasks** — research, exploration, codebase analysis, and general investigation. Use Claude agents for:
- Review passes (especially `review-thorough`, `review-adversarial`)
- Frontend implementation and planning
- Tasks requiring deep architectural reasoning

### Frontend

- use `pnpm` instead of `npm` for faster compile times
- run `pnpm run lint` to run ESLint after making changes
- run `pnpm run format 2>&1 | grep -v "unchanged"` after Tailwind/CSS class changes

## Deployment

- **Backend**: Railway
- **Database**: Supabase (PostgreSQL)
- **Frontend**: Vercel

See `backend/AGENTS.md` for backend deployment details.

## Refactoring Backlog

Technical debt is tracked in `_docs/future/refactoring-backlog.md`. Use `/backlog` to:
- Review current items
- Add new discoveries
- Work on refactors
