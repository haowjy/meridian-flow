# Development guide (v3 / meridian-collab)

Setup and day-to-day workflow for the TypeScript monorepo on branch `h/v3`.

See also [AGENTS.md](AGENTS.md), [CHANGELOG.md](CHANGELOG.md), and [.cursor/rules/commit-phase-discipline.mdc](.cursor/rules/commit-phase-discipline.mdc).

## First-time setup

```bash
pnpm install
cp .env.example .env
pnpm supabase:start
pnpm supabase:env    # copy printed keys into .env
pnpm exec lefthook install --reset-hooks-path
pnpm bootstrap       # migrate + apply-functions (schema only)
```

`pnpm install` runs `prepare` → `lefthook install`. On a **git worktree** that often fails (see [Git hooks](#git-hooks-lefthook) below); run the `--reset-hooks-path` command once after install.

## Local database

Postgres comes from Supabase CLI. App schema is Drizzle in `packages/database` (not `supabase/migrations`). Auth is WorkOS AuthKit with app-owned `public.users`.

| Command | Purpose |
|---------|---------|
| `pnpm supabase:start` | Docker: API `:54421`, Postgres `:54422`, Studio `:54423` |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:apply-functions` | Sync `src/functions/*.sql` after editing PL/pgSQL |
| `pnpm db:generate` | Generate migration SQL from schema changes |
| `pnpm db:studio` | Drizzle Kit Studio |
| `pnpm bootstrap` | Migrate + apply PL/pgSQL functions (no user/project seed) |

Details: [supabase/README.md](supabase/README.md), [packages/database/README.md](packages/database/README.md).

## Git hooks (lefthook)

This repo is often checked out as a **worktree** of `meridian` (`git worktree list`). The parent repo may set:

```text
core.hooksPath = /path/to/meridian/.git/hooks
```

Plain `lefthook install` (including via `pnpm install` / `prepare`) then refuses to install and prints a hint to reset the hooks path.

**Use this once per worktree checkout** (from the repo root, e.g. `meridian-collab`):

```bash
pnpm exec lefthook install --reset-hooks-path
```

That installs hooks for **this** worktree so commits run the checks in [lefthook.yml](lefthook.yml):

| Hook | Runs |
|------|------|
| **pre-commit** | `pnpm biome check --staged` → `pnpm typecheck` |
| **pre-push** | `pnpm --filter @meridian/database test` |

Verify:

```bash
pnpm exec lefthook run pre-commit
pnpm exec lefthook run pre-push
```

Do **not** use `git commit --no-verify` unless explicitly approved.

### If you are not on a worktree

`pnpm exec lefthook install` (or `pnpm install` via `prepare`) is enough.

## Commits, hooks, and step-by-step history

Branch history should replay verified work: **one plan phase or logical step → one commit**, with hooks green before the next step.

1. Finish one phase or logical step.
2. Stage **only** files for that step.
3. `git commit` with a message that states what and why.
4. Add a matching bullet under [CHANGELOG.md](CHANGELOG.md) → `## [Unreleased]`.
5. Start the next phase.

Prefer separate commits per package or layer when it helps review (e.g. `packages/database`, then `tools/dev`). Fold small review fixes into that phase’s commit or an immediate follow-up.

`git log --oneline` on `h/v3` should read like the plan: phase → verified commit → next phase.

## Checks (manual)

Same gates as hooks, useful before push:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check          # lint + typecheck + test
```

## Dev server

Portless + tmux (not raw `localhost:3000`). See [AGENTS.md — Dev environment](AGENTS.md#dev-environment-portless).

```bash
pnpm dev
pnpm portless:list
```

## Workstation: memory-safe ripgrep

`rg` on this machine is wrapped at `~/.local/bin/rg` to prevent OOM kills. A bare `rg` over a large codebase can mmap hundreds of GB of virtual address space and exhaust RAM (this happened — it killed a tmux session).

The wrapper enforces:
- `--no-mmap` — sequential reads instead of memory-mapped I/O, keeps VSZ low
- `--max-filesize 500M` — skips files larger than 500 MB
- `-j 4` — caps parallel search threads
- cgroup limits via `systemd-run`: `MemoryHigh=6G`, `MemoryMax=10G`, `MemorySwapMax=4G`

To bypass (e.g. searching a legitimately large file):
```bash
~/.local/bin/rg.real [flags] [pattern] [path]
```

Also recommended — install `earlyoom` as a system-wide backstop:
```bash
sudo apt install earlyoom
# In /etc/default/earlyoom:
# EARLYOOM_ARGS="-m 4,3 -s 10,5 --prefer '(^|/)(rg|ripgrep)$' --sort-by-rss -g -r 60"
sudo systemctl enable --now earlyoom
```
