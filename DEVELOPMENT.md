# Development guide (v3)

Setup and day-to-day workflow for the TypeScript monorepo.

See also [AGENTS.md](AGENTS.md), the PR body's `## Changelog` section, and [.cursor/rules/commit-phase-discipline.mdc](.cursor/rules/commit-phase-discipline.mdc).

## Environment

Secrets and provider keys live in **`.env` on the main git checkout** (copy from [`.env.example`](.env.example)). Linked worktrees do not get their own `.env` — [`.envrc`](.envrc) loads the main checkout file via `git-common-dir`, then rewrites `DATABASE_URL` to a worktree-scoped database (`meridian_<slug>` on the shared `:54422` Postgres server).

Use **direnv** so the shell picks up `.envrc`. `pnpm bootstrap` runs `direnv allow` when direnv is installed; re-enter the directory or run `direnv reload` if variables look stale.

### Toolchain

Node and Python are pinned in [`.tool-versions`](.tool-versions) (Node 24.17.0, Python 3.12) and loaded through mise:

```bash
mise install                  # install the pinned versions
mise direnv                   # once per machine: writes the use_mise helper .envrc calls
eval "$(mise activate bash)"  # add to ~/.bashrc so every shell gets the pinned Node and Python
```

[`.envrc`](.envrc) starts with `use mise`, which exists only after `mise direnv`. Without it direnv stops with `use_mise: command not found` and no project variables load.

Runtime dev-tool contracts: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md).

### Stripe test-mode workflow

Local dev can run with no Stripe keys. In that mode the billing gateway is
`null`: checkout, portal, and Stripe webhooks are unavailable, but the free tier
and model-call consumption still work against the local credit ledger.

To exercise checkout or webhooks, set Stripe test-mode values in the main
checkout's `.env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the
`STRIPE_PRICE_PLAN_*` entries used by the billing catalog. Run the Stripe CLI to
forward test webhooks to the local portless server route, then use Stripe test
cards / test subscriptions.

## First-time setup (main checkout)

Clone with a blob filter, so screenshots, the lockfile and migration snapshots
download only when something reads them:

```bash
git clone --filter=blob:limit=200k <repo-url>
```

That fetches about 100 MB, source history included, instead of the whole history
(about 370 MB). The current tree's large files download on checkout, and an old
image downloads on first read.

Then, in the checkout:

```bash
mise install                  # pinned Node and Python from .tool-versions
mise direnv                   # once per machine: the use_mise helper .envrc calls
eval "$(mise activate bash)"  # or add this line to ~/.bashrc
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
| Nx task cache | Shared with the main checkout. A cache hit replays output that can name another worktree's paths; the hit still means identical inputs. `NX_SKIP_NX_CACHE=true pnpm typecheck` forces a fresh run |

**First browser load after `pnpm install`** in a fresh worktree can hit a
stale-Vite-deps crash: Vite's pre-bundled dependency cache may hold a
duplicate React copy, causing `useContext` to return `null` in layout
components (e.g. `AuthenticatedLayout`). A hard reload (Ctrl+Shift+R) clears
the stale bundle and resolves it. This is a Vite dep-optimization artifact,
not an app bug.

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
| `pnpm dev:gc-dbs -- --yes` | Drop stale worktree and stopped managed-test databases; preserve live worktrees, active tests, reserved manual-test names, and reserved databases |

### Resetting a dev database

Until launch, resetting a database is always an option. `pnpm db:reset`, run
from the checkout that owns the database, destroys its schema and data, then
installs the migrations from `0000_baseline` and the post-migrate functions.
Back up anything you need first. `pnpm db:migrate` cannot upgrade a database
whose migration history predates `0000_baseline`; reset it instead. Never reset
someone else's database or a shared deployment.

Against local Postgres, `pnpm test:db` creates and migrates a uniquely named
template owned by that invocation and clones eight isolated worker databases
from it. Set `DB_TEST_WORKERS=1..8` to lower concurrency on a busy server. After
Vitest exits, an ownership-validated detached child drops the workers and
template without making the test command wait for PostgreSQL checkpoints.
Cleanup logs live in `.meridian/db-test-cleanup/<owner-pid>.log`.
`pnpm dev:gc-dbs -- --yes` recognizes managed names and can reclaim leftovers
(or in-flight cleanup) only after the owning test process has stopped. Manually named test
databases that must survive GC use `<base>_test-manual-<label>`; test lifecycle
prefixes are reserved from worktree slugs.

## Worktree cleanup

Merged or finished work leaves several linked resources behind. `pnpm dev:prune-worktrees` tears them down safely:

```bash
pnpm dev:prune-worktrees -- --target <value> --dry-run # inspect one work id, path, branch, or PR
pnpm dev:prune-worktrees -- --target <value>           # clean that target after confirmation
```

Targeted cleanup runs in order: stop dev stack → drop database → remove git
worktree → optionally mark a linked Meridian work item done → delete the local
branch. Eligibility is bound to the planned branch commit and revalidated before
every action. Targeted cleanup accepts the commit contained in another surviving
local or remote-tracking ref (own refs resolved against the configured remote
names, symbolic refs excluded, remote-tracking candidates verified against their
remote before the check), or an exact merged PR into any base branch; each
matched PR's head commit and repository owner must match. Batch cleanup still requires an exact merged PR into
the detected base branch and keeps refusing duplicate exact records. Executing
cleanups are serialized per repository, so two runs cannot each treat the other's
branch as the surviving ref; a stale lock refuses rather than being taken over.
The resolver refuses primary/current or locked worktrees, the detected base
branch, commits no other ref contains (unless an exact merged PR or manual
evidence covers them), dirty worktrees, and refs that move after planning.

Batch cleanup is advanced and not yet trusted for routine use. It requires an
explicit acknowledgement:

```bash
pnpm dev:prune-worktrees -- --auto --acknowledge-batch-risk --dry-run
```

Automatic cleanup skips any worktree that is dirty, carries an active Meridian
work item, has a live dev session, or has a process attributed to it. A readable
process cwd inside the target blocks it; when cwd is unreadable, a cmdline
reference to the target path blocks only that target. Because an active work
item is a skip reason, mark it done before `--auto`; auto cleanup then runs four
actions (stop dev, drop database, remove worktree, delete branch) rather than the
targeted path's optional fifth `meridian work done` action.

Details: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md), [packages/database/README.md](packages/database/README.md).

## Git hooks (lefthook)

`pnpm install` runs `prepare` → `lefthook install`. When the parent repo sets `core.hooksPath` to another checkout's hooks directory, plain install fails — common on linked worktrees.

```bash
pnpm exec lefthook install --reset-hooks-path
```

Run once per checkout (main or worktree). Hooks in [lefthook.yml](lefthook.yml):

| Hook | Runs |
|------|------|
| **pre-commit** | Staged Biome, staged migration lint, then `pnpm typecheck:staged` |
| **pre-push** | Debug-probe checks, then `pnpm --filter @meridian/database test` |

`typecheck:staged` skips documentation-only changes. Otherwise, Nx selects projects
and dependent consumers from staged paths, including both ends of a rename and
deleted paths. Shared configuration and dependency changes select the wider set.
Selection reads the Git index; each project's configured check reads the working
tree, including unstaged edits. It does not validate a staged snapshot or stash
files. `pnpm typecheck`, `pnpm check` and CI retain full-project checks.
See [selection and cache inputs](tools/ci/README.md#staged-typechecking).

Verify: `pnpm exec lefthook run pre-commit` / `pre-push`. Do **not** use `git commit --no-verify` unless explicitly approved.

## Commits and step-by-step history

Branch history should replay verified work: **one plan phase or logical step → one commit**, with hooks green before the next step.

1. Finish one phase or logical step.
2. Stage **only** files for that step.
3. `git commit` with a message that states what and why.
4. Add the matching `Added:`, `Changed:`, `Fixed:` or `Removed:` line to the PR body's `## Changelog` section.
5. Start the next phase.

Prefer separate commits per package or layer when it helps review (e.g. `packages/database`, then `tools/dev`). Fold small review fixes into that phase's commit or an immediate follow-up.

`git log --oneline` on the branch should read like the plan: phase → verified commit → next phase.

## Checks (manual)

Full gates, beyond the staged selection used at commit time:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check          # static/unit gates + DB suites when local Postgres is reachable
pnpm test:db        # force the managed Postgres-backed suite
pnpm test:all       # unit + managed DB suites in one Vitest run (requires Postgres)
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

Restart terminates this worktree's owned tmux session, then owns its configured
fixed ports. It logs each remaining holder by PID and command, sends SIGTERM,
waits briefly, and sends SIGKILL to stragglers. An uninspectable bound port still
aborts startup with diagnostics.

## Workstation: wrapped ripgrep

On the maintainer's workstation, `rg` is a memory-capped wrapper; run
`~/.local/bin/rg.real` to bypass it.

## Vite crashes with ENOSPC (file watchers)

With several dev worktrees plus an editor running, the kernel inotify watch
budget can run out; Vite then dies mid-HMR with
`ENOSPC: System limit for number of file watchers reached` and the app drops
off portless. Raise the limit and restart the dev session:

```bash
sudo sysctl fs.inotify.max_user_watches=1048576
# persist: echo fs.inotify.max_user_watches=1048576 | sudo tee /etc/sysctl.d/60-inotify.conf
pnpm dev --restart
```

Editors are the biggest consumers (a long-running Cursor/VS Code can hold
200k+ watches) — restarting the editor also frees budget.
