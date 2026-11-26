# Development guide (v3)

Setup and day-to-day workflow for the TypeScript monorepo.

See also [AGENTS.md](AGENTS.md), the PR body's `## Changelog` section, and [.cursor/rules/commit-phase-discipline.mdc](.cursor/rules/commit-phase-discipline.mdc).

## Environment

Secrets and provider keys live in **`.env` on the main git checkout** (copy from [`.env.example`](.env.example)). Linked worktrees do not get their own `.env`, and no repo value is exported into your shell. Every dev entry point (`pnpm dev`, `pnpm bootstrap`, `db:*`, `pnpm test:db`, Playwright, the smoke scripts) loads its own env at startup through `applyDevEnvToProcess` ([`tools/dev/lib/dev-env.ts`](tools/dev/lib/dev-env.ts)): the checkout's own `.env.local` (gitignored, per-checkout overrides) first, then the main checkout's `.env`, each filling only variables the shell has not set. A variable the shell sets wins even when its value is empty, and so does a key in `.env.local`: `LIVE_TEST_MODEL=` in either turns off a main-`.env` setting. This holds for `pnpm dev` too: the stack gets your shell's environment (minus `INIT_CWD`, `npm_*` and `NX_*`, which pnpm and Nx set for the command itself), so `COMPACTION_SUMMARIZER_MODEL=foo pnpm dev` reaches the server. `pnpm dev:restart` restarts the services with the environment the stack started with and reads the `.env` files again, so `MODEL_PROVIDER=mock pnpm dev` then `pnpm dev:restart` stays on the mock. To change or drop a shell variable, `pnpm dev --stop`, then start again with the environment you want. `pnpm dev` is the supported way to run the stack: a bare `nitro dev` gets no repo env, and a bare `vite dev` in `apps/app` reads only its own checkout's `.env*` files (Vite `loadEnv`), so a linked worktree gets none of the main `.env`.

Set `DATABASE_URL` only in the main `.env`: the main checkout uses that database and each linked worktree gets `<name>_<worktree directory name>` on the same server (`:54422`), whatever branch is checked out in it. Setting it in `.env.local`, or leaving another checkout's URL in your shell, is an error.

For `psql`, run `tools/dev/psql [psql args…]`. It targets this checkout's database through `PG*` variables set for `psql` alone, so nothing stays in your shell or shows in `ps`.

### Toolchain

Node, Bun and Python are pinned in [`.tool-versions`](.tool-versions): Node 26.13.1, Bun 1.4.4, and Python 3.12, which resolves to the newest installed 3.12.x. Bun runs the TypeScript scripts under `tools/` and `./mf`; Vite, Nitro, Vitest and production run on Node. `mise activate` in your shell rc resolves the pins.

```bash
mise install                  # download the pinned versions
eval "$(mise activate bash)"  # add to ~/.bashrc so every shell gets the pinned Node, Bun and Python
```

`mise current` prints the versions a shell resolves (`node 26.13.1`, `bun 1.4.4`, `python 3.12.x`).

Runtime dev-tool contracts: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md).

### Stripe test-mode workflow

Local dev can run with no Stripe keys. In that mode the billing gateway is
`null`: checkout, portal, and Stripe webhooks are unavailable, but the free tier
and model-call consumption still work against the local credit ledger.

To exercise checkout or webhooks, set Stripe test-mode values in the main
checkout's `.env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the
`STRIPE_PRICE_PLAN_*` entries used by the billing catalog. Run the Stripe CLI to
forward test webhooks to the server URL from `pnpm dev:urls`, then use Stripe test
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
mise install                  # pinned Node, Bun and Python from .tool-versions
eval "$(mise activate bash)"  # or add this line to ~/.bashrc
pnpm install
cp .env.example .env          # DEV_AUTH_BYPASS=1 needs no WorkOS keys; fill them in for real login
pnpm dev:infra                # start the Postgres + pg_bigm Docker container (:54422) if not running
pnpm exec lefthook install --reset-hooks-path
pnpm bootstrap                # create the DB and install the baseline
pnpm dev
pnpm dev:urls
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
| `.env` | Read from the main checkout (no copy into the worktree); `.env.local` here overrides it, except `DATABASE_URL` |
| `DATABASE_URL` | Derived as `meridian_<worktree directory name>` from the main `.env` (main checkout keeps `meridian`); a different one in your shell throws |
| Postgres | One Docker container on `:54422`; each worktree gets its own database |
| Ports | Each checkout's own block, kept as `DEV_PORT_BASE` in its `.env.local` (chosen the first time `pnpm dev` or `pnpm dev:urls` runs in a worktree); `pnpm dev:urls` prints them |
| `pnpm dev:infra` | Shared — starts Postgres only if it is not already running and healthy; never touches a running server |
| `pnpm dev:infra:upgrade` | Shared — recreates the container onto the image tag in your checkout's compose file. Run it from a checkout that has merged `main`; an older branch's compose file would flip the server back to the image it knows |
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

Postgres comes from a Docker container built from `tools/postgres/Dockerfile`: `postgres:16` plus `pg_bigm` (btree_gin and pg_trgm are contrib), with `pg_bigm` preloaded. Writer search needs all three. Compose is `tools/dev/docker-compose.yml`. App schema is Drizzle in `packages/database`. Auth is WorkOS AuthKit with app-owned `public.users`. Local dev can skip it: `DEV_AUTH_BYPASS=1` makes every request the dev user (`DEV_AUTH_USER_ID`, default `test`, email `<id>@example.com`), refused outside `NODE_ENV=development`. Set it to `0` to test real login.

| Command | Purpose |
|---------|---------|
| `pnpm dev:infra` | Start the Postgres Docker container (`:54422`) if it is not running and healthy; a running container is left alone, so any branch's `bootstrap` is safe |
| `pnpm dev:infra:upgrade` | Build the image and recreate the container onto the tag in `docker-compose.yml`; the data volume stays. The one command that moves the shared server to a new image (e.g. after merging `main` that bumps the pg_bigm tag, or from the older plain `postgres:16`) |
| `pnpm db:check-extensions` | Prove pg_bigm is preloaded and the search extensions install and serve a 1-character Han `LIKE` (rolled back) |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:generate` | Regenerate the baseline from schema and SQL inputs |
| `pnpm db:studio` | Drizzle Kit Studio |
| `tools/dev/psql [args…]` | Run `psql` against this checkout's database |
| `pnpm bootstrap` | Ensure DB + install baseline |
| `pnpm dev:gc-dbs -- --yes` | Drop stale worktree and stopped managed-test databases; preserve live worktrees, any database with a connection, active tests, reserved manual-test names, and reserved databases |

### Resetting a dev database

Until launch, resetting a database is always an option. `pnpm db:reset`, run
from the checkout that owns the database, destroys its schema and data, then
installs the baseline from `0000_baseline` and the included SQL functions.
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
prefixes are reserved from worktree directory names.

## Worktree cleanup

Remove a finished worktree from another checkout:

```bash
wt remove <branch>
```

worktrunk refuses a dirty or unmerged worktree and deletes the merged branch. The
checkout's dev stack stops itself within 15 seconds of the checkout disappearing,
however it was removed. The repository's `post-remove` hook
([`.config/wt.toml`](.config/wt.toml)) then runs `pnpm dev:gc-dbs -- --yes`, which
drops every database whose worktree no longer exists. worktrunk asks once per
machine to approve that hook; `--yes` answers it for an agent.

After removing a worktree any other way (`git worktree remove`, deleting the
folder), run `pnpm dev:gc-dbs -- --yes` yourself.

Details: [tools/dev/.context/CONTEXT.md](tools/dev/.context/CONTEXT.md), [packages/database/README.md](packages/database/README.md).

## Git hooks (lefthook)

`pnpm install` runs `prepare` → `lefthook install`. When the parent repo sets `core.hooksPath` to another checkout's hooks directory, plain install fails — common on linked worktrees.

```bash
pnpm exec lefthook install --reset-hooks-path
```

Run once per checkout (main or worktree). Hooks in [lefthook.yml](lefthook.yml):

| Hook | Runs |
|------|------|
| **pre-commit** | Staged Biome, then `pnpm typecheck:staged` |
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

Each checkout's stack runs on its own `localhost` ports
([`tools/dev/lib/dev-ports.ts`](tools/dev/lib/dev-ports.ts)). The main checkout uses
20000 (app), 20001 (server) and 20002 (www). A linked worktree gets a block of its
own between 20010 and 27999: the first command there that needs the ports (`pnpm dev`,
`pnpm dev:urls`) picks one from a hash of the worktree's path, skips blocks this
repository's other checkouts already hold, and writes it to the worktree's `.env.local`
as `DEV_PORT_BASE=<port>`. That line is the only place a checkout's ports come from;
`DEV_PORT_BASE` in the shell is ignored. If another program holds a port, `pnpm dev`
fails naming it: change the number in `.env.local`. The same line in the main
checkout's `.env.local` moves the main stack off 20000.

```bash
pnpm dev                    # start the app and server; prints the URLs when both answer
pnpm dev --www              # also run the marketing site
pnpm dev --tailscale        # also publish the stack on your tailnet (see below)
pnpm dev:production-client  # serve the built client instead of Vite's dev client
pnpm dev:urls               # this checkout's URLs, and whether the stack is up
pnpm dev:restart            # restart the services in place, same environment
pnpm dev --stop             # stop this checkout's stack
pnpm dev:stacks             # every checkout's running stack, its memory and idle time
```

`pnpm dev` starts one background supervisor (`tools/dev/dev-supervisor.ts`) that
runs the services and writes their output to `logs/dev.log`. It records itself in
`.meridian/dev-stack.json`, which is how `--stop`, `./mf` and `pnpm dev:stacks`
find the stack. The supervisor stops the whole stack when a service exits, when
the checkout is removed, or after `DEV_IDLE_STOP_MINUTES` (default 60, `0` turns
it off) without work.

The browser talks only to the app URL: Vite proxies the server's HTTP and
WebSocket paths to the server's port.

### Opening a stack from another device

The services listen on `127.0.0.1` only. `pnpm dev --tailscale` also publishes the
stack on your tailnet with `tailscale serve`, on the same port numbers:
`https://<machine>.<tailnet>.ts.net:<app port>`, and the www port with `--www`. The
URLs are printed with the others. The routes last as long as the stack: any stop
removes them, an idle stop included. A port that Tailscale already serves for something
else is never replaced; the start fails and names it. The dev sign-in bypass accepts a
tailnet host, so anyone on the tailnet then acts as the dev user.

Without Tailscale, forward the app port over SSH:
`ssh -L <port>:localhost:<port> <host>`.

### After a reboot

Postgres must be running before `pnpm dev`. The container restarts with Docker
(`restart: unless-stopped`); if it is missing, run `pnpm dev:infra`.

## Workstation: wrapped ripgrep

On the maintainer's workstation, `rg` is a memory-capped wrapper; run
`~/.local/bin/rg.real` to bypass it.

## Vite crashes with ENOSPC (file watchers)

With several dev worktrees plus an editor running, the kernel inotify watch
budget can run out; Vite then dies mid-HMR with
`ENOSPC: System limit for number of file watchers reached` and the stack
stops. On Linux, raise the limit and start it again:

```bash
sudo sysctl fs.inotify.max_user_watches=1048576
# persist: echo fs.inotify.max_user_watches=1048576 | sudo tee /etc/sysctl.d/60-inotify.conf
pnpm dev
```

Editors are the biggest consumers (a long-running Cursor/VS Code can hold
200k+ watches) — restarting the editor also frees budget.
