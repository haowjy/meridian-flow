# Development guide (v3)

Setup and day-to-day workflow for the TypeScript monorepo on branch `h/v3`.

See also [AGENTS.md](AGENTS.md), [CHANGELOG.md](CHANGELOG.md), and [.cursor/rules/commit-phase-discipline.mdc](.cursor/rules/commit-phase-discipline.mdc).

## Environment

Secrets and provider keys live in **`.env` on the main git checkout** (copy from [`.env.example`](.env.example)). Linked worktrees do not get their own `.env` — [`.envrc`](.envrc) loads the main checkout file via `git-common-dir`, then rewrites `DATABASE_URL` to a worktree-scoped database (`meridian_<slug>` on the shared `:54422` Postgres server).

Use **direnv** so the shell picks up `.envrc`. `pnpm bootstrap` runs `direnv allow` when direnv is installed; re-enter the directory or run `direnv reload` if variables look stale.

Runtime dev-tool contracts: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md).

## First-time setup (main checkout)

```bash
pnpm install
cp .env.example .env          # fill in WorkOS keys, etc.
pnpm dev:infra                # start postgres:16 Docker container (:54422)
pnpm exec lefthook install --reset-hooks-path
pnpm bootstrap                # direnv allow + migrate + apply-functions
pnpm dev
pnpm portless:list
```

## Linked worktree

Feature work runs in a separate directory, not the main checkout. Create one:

```bash
git worktree add ../meridian-flow.worktrees/<slug> -b h/<branch>
cd ../meridian-flow.worktrees/<slug>
pnpm install
pnpm exec lefthook install --reset-hooks-path   # once per worktree
pnpm bootstrap                                  # scoped DB + migrate; skips if infra already up
pnpm dev
```

| Concern | Behavior |
|---------|----------|
| `.env` | Loaded from main checkout (no copy into the worktree) |
| `DATABASE_URL` | Rewritten to `meridian_<slug>` (main checkout keeps `meridian`) |
| Postgres | One Docker container on `:54422`; each worktree gets its own database |
| `pnpm dev:infra` | Shared — start once if Postgres is not already running |
| Git hooks | `lefthook install --reset-hooks-path` once per worktree (see below) |
| Commits | Run `git` from the worktree directory you edited in |

## Local database

Postgres comes from a plain `postgres:16` Docker container (see `tools/dev/docker-compose.yml`). App schema is Drizzle in `packages/database`. Auth is WorkOS AuthKit with app-owned `public.users`.

| Command | Purpose |
|---------|---------|
| `pnpm dev:infra` | Start `postgres:16` Docker container (`:54422`) |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:apply-functions` | Sync `src/functions/*.sql` after editing PL/pgSQL |
| `pnpm db:generate` | Generate migration SQL from schema changes |
| `pnpm db:studio` | Drizzle Kit Studio |
| `pnpm bootstrap` | `direnv allow` (if installed) + ensure DB + migrate + apply-functions |

## Worktree cleanup

Merged or finished work leaves several linked resources behind. `pnpm dev:prune-worktrees` tears them down safely:

```bash
pnpm dev:prune-worktrees -- --auto             # plan cleanup for all merged worktrees
pnpm dev:prune-worktrees -- --target <value>   # target by work id, path, branch, or PR number
pnpm dev:prune-worktrees -- --auto --dry-run   # print plan without executing
pnpm dev:prune-worktrees -- --auto --yes       # execute without confirmation
```

Per target, cleanup runs in order: stop dev stack → drop database → remove git worktree → delete local branch → mark Meridian work done. The resolver refuses primary worktree, current worktree, `main` branch, and unmerged branches.

Details: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md), [packages/database/README.md](packages/database/README.md).

## Git hooks (lefthook)

`pnpm install` runs `prepare` → `lefthook install`. When the parent repo sets `core.hooksPath` to another checkout's hooks directory, plain install fails — common on linked worktrees.

```bash
pnpm exec lefthook install --reset-hooks-path
```

Run once per checkout (main or worktree). Hooks in [lefthook.yml](lefthook.yml):

| Hook | Runs |
|------|------|
| **pre-commit** | `pnpm biome check --staged` → `pnpm typecheck` |
| **pre-push** | `pnpm --filter @meridian/database test` |

Verify: `pnpm exec lefthook run pre-commit` / `pre-push`. Do **not** use `git commit --no-verify` unless explicitly approved.

## Commits and step-by-step history

Branch history should replay verified work: **one plan phase or logical step → one commit**, with hooks green before the next step.

1. Finish one phase or logical step.
2. Stage **only** files for that step.
3. `git commit` with a message that states what and why.
4. Add a matching bullet under [CHANGELOG.md](CHANGELOG.md) → `## [Unreleased]`.
5. Start the next phase.

Prefer separate commits per package or layer when it helps review (e.g. `packages/database`, then `tools/dev`). Fold small review fixes into that phase's commit or an immediate follow-up.

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

Portless + tmux (not raw `localhost:3000`). See [AGENTS.md — Dev environment](AGENTS.md#dev-environment).

```bash
pnpm dev                  # start (tailscale serve by default)
pnpm dev --no-tailscale   # local-only (no Tailscale exposure)
pnpm dev --funnel         # public internet via Tailscale Funnel
pnpm dev --print          # dry-run: print the session plan (secrets redacted)
pnpm dev --stop           # stop this worktree's tmux session + prune routes
pnpm dev --restart        # stop + restart (preserves mode unless --no-tailscale/--funnel)
pnpm portless:list        # live localhost HTTPS URLs
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
