---
detail: minimal
audience: developer
---

# Frontend Setup Quickstart

## Prerequisites

- Node.js LTS, pnpm v10+
- Backend API running (see backend quickstart)

## Environment

Copy `frontend/.env.example` to `frontend/.env.local`:

| Variable | Value | Notes |
|----------|-------|-------|
| `VITE_SUPABASE_URL` | `https://your-project.supabase.co` | From Supabase project settings |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `your-anon-key` | From Supabase API settings |
| `VITE_API_URL` | `http://localhost:8080` | Must match backend port |
| `VITE_DEV_TOOLS` | `0` | Set `1` for retry inspector overlay |

Backend port is worktree-aware (`8080 + hash(dir) % 100`). Check with `source scripts/dev/lib.sh && echo $BACKEND_PORT`.

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install dependencies |
| `pnpm run dev` | Dev server at localhost:3000 |
| `pnpm run build` | `tsc --noEmit` + vite build |
| `pnpm run lint` | ESLint |
| `pnpm run format 2>&1 \| grep -v "unchanged"` | Prettier write (Tailwind class sorting) |
| `pnpm run test` | Vitest unit tests |

All commands run from `frontend/`.

## Dev Environment (tmux)

```bash
./scripts/dev/setup.sh   # Creates tmux session with backend + frontend
tmux attach -t <session> # Session name = branch basename
```

See root `CLAUDE.md` "Dev Environment Setup" for full details.

## Architecture Notes

- Backend is system of record; IndexedDB (Dexie) and localStorage are caches.
- See `frontend/CLAUDE.md` for store conventions, caching patterns, and coding guidelines.
- See `_docs/technical/frontend/architecture/sync-system.md` for sync architecture.
