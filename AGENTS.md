# AGENTS.md

This file provides guidance when working with the code in this repository.

## Project Overview

Meridian is an agentic writing platform for writers, starting with fiction writers who manage 100+ chapter web serials, but being inclusive for any kind of writer.

For product details, see `_docs/high-level/1-overview.md`.

There are no users and there is no real user data. No need for backwards compatibility. It's okay to completely change the schema to get it into the right shape.

## Product Philosophy

**Writer-first**: Meridian exists to serve the writer. Every feature, UI element, and AI interaction should support—not distract from—the writing process.

See `frontend/CLAUDE.md` for UI-specific implementation of this philosophy.

## Guiding Principles for Development

ALWAYS FOLLOW SOLID PRINCIPLES.
ALWAYS ENSURE THERE IS A PLAN APPROVED BY THE USER BEFORE IMPLEMENTING ANYTHING GREATER THAN A FEW LINES OF CODE. This is to make sure a developer understands the situation and knows whats happening to the system. You should also make sure to follow [[## Before Writing New Code]]

**DO NOT ENTER PLAN MODE.** Instead, write plans as markdown files in `_docs/plans/`. During planning, use `/run-agent` (via the `researching` skill) for research and codebase exploration — stay in the normal conversation so these tools remain available. See [[### Plan Lifecycle]] for the full workflow.

### SOLID Quick Reference

- **SRP**: Files should only have a single purpose. One store = one domain. Split large components.
- **OCP**: Use registries/factories for extensibility (see ToolRegistry, BlockRenderer)
- **LSP**: All implementations must be substitutable for their interfaces
- **ISP**: Split large interfaces (Reader vs Writer, Metadata vs CRUD)
- **DIP**: Depend on interfaces, not concrete types (especially for external services)

2. **Comment the "Weird" and the "WHY"**
   - anything that is not obvious, comment why.
   - If it needs a guard, comment why
   - If it prevents a race, explain the race
   - If you had to debug it, future you will too

3. **Keep Documentation Up-to-Date** - Update documentation AFTER finalizing changes. See "Feature Documentation Sync Rule" for feature documentation workflow.

## Before Writing New Code

1. **Search for existing patterns** - Before implementing, search for similar implementations

2. **Reuse over recreate** - If a pattern exists, use it. If it's close but not quite right, extend it.

3. **Check shared utilities** - Before writing a helper, search for existing utilities. If it is almost there, refactor/change the existing utility

4. **When patterns diverge, consolidate** - If you find 2+ implementations of the same thing, refactor to one.

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend**: `frontend/CLAUDE.md` - Caching patterns, store architecture, CodeMirror conventions

### Documentation

- read `_docs/AGENTS.md` or `_docs/CLAUDE.md` before updating any documents under `_docs/`
- The gist documentation should prefer diagrams (`/mermaid` skill) over words, higher level than code, and should POINT to code folders/locations. Documentation should know the WHY and generally, at a high level, the WHAT.

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

To check your worktree's port: `source scripts/dev/lib.sh && echo $BACKEND_PORT`

Optional override: create `.dev-ports` (gitignored) in repo root:
```bash
BACKEND_PORT=8081
FRONTEND_PORT=3001
```

**Daily usage:**
- Start: `./scripts/dev/setup.sh` (creates tmux session)
- Restart backend: `./scripts/restart-server.sh`
- Attach: `tmux attach -t <session_name>`
- Session name = branch basename (e.g., `h_meridian_collab`)

**Agent permissions:**
- Claude CAN restart the backend server via: `./scripts/restart-server.sh`
- Claude CAN run curl commands to test APIs
- Claude CAN run `./scripts/get-token.sh` to refresh `ACCESS_TOKEN` in root `.env` before authenticated smoke tests

### Git Commits

- For long-running tasks where you are `/orchestrate`ing, commit after each "testable" state, most often after each task of a plan. If the human is in the loop, you should confirm with the user before committing.
- Follow repository's commit message style

### Planning

Make sure you use the `/mermaid` skill to help make markdown diagrams for your plans to help you and the user understand the plan. Using `/orchestrate` and multiple agents to review-cycle through the plan can help you catch issues early and get a better plan.

### Testing

- User runs tests manually or via CI/CD
- Claude can suggest test commands
- Claude can help write/fix tests

### Smoke Testing

Token refresh is agent-authorized. See `backend/CLAUDE.md` -> "Smoke Testing" for full details. See the `/scratchpad` skill for scratch/smoke file conventions.

### Long-Running Tasks

For multi-phase plans, use the `/orchestrate` skill and NEVER write implementation code yourself. It discovers available skills, picks the right model for each subtask, and you should composes runs via `run-agent.sh`. See the orchestrate skill's SKILL.md for full details.

**Install:** `/plugin marketplace add jimmyyao/orchestrate` (Claude Code)
**Skills:** `*/SKILL.md` under `orchestrate/skills/` — self-describing building blocks discovered at runtime.
**Model guidance:** loaded from `run-agent/references/` — model strengths, task-type heuristics, and skill-composition patterns.

### Plan Lifecycle

All plans live in `_docs/plans/`. **Never use Claude Code's built-in plan mode.**

- **Research first** — use `/run-agent` with the `researching` skill before writing a plan.
- **Write plans** to `_docs/plans/<name>.md` with a `**Status:**` field at the top (`draft → approved → in-progress → done`).
- **Never overwrite** an existing plan — move it to `_docs/plans/_archive/` first.
- **Archive when done** — move completed plans to `_docs/plans/_archive/`.

### Plan Execution

- **Multi-stage plans** (2+ stages): Execute via `/orchestrate`. Never implement multi-stage plans directly.
- **Single-stage plans**: You may implement directly. Update progress in the plan file as you go.

### Model Selection

The orchestrator dynamically selects models based on model guidance (loaded from `run-agent/references/`). You MUST write a good prompt and pass in correct context files for the task/plan at hand. 

General heuristics:
- **Implementation**: `gpt-5.3-codex` (default), `claude-opus-4-6` (UI iteration + rare different perspectives)
- **Review**: Fan out to multiple model families for medium/high risk changes
- **Research**: Use model diversity for different perspectives
- **Commit**: `claude-haiku-4-5` to help create commits for the changes
- **Documentation**: `claude-haiku-4-5` to help find the files that need to be updated for the changes you are making, `claude-opus-4-6` to help write the documentation itself.

See `orchestrate/skills/run-agent/references/default-model-guidance.md` for detailed heuristics.

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

Technical debt is tracked in `_docs/future/refactoring-backlog.md`. Use `/backlog-managing` to:
- Review current items
- Add new discoveries
- Work on refactors
