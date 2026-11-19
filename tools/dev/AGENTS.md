# tools/dev

Local-development utilities. Production code never imports this directory, and
this directory never imports application packages. The `./mf` CLI lives in
[`tools/mf`](../mf/AGENTS.md).

## Rules

- Dev sessions live on the private tmux socket in `lib/dev-tmux-socket.ts`
  (`-L meridian-flow-dev`). Build every dev-session tmux call from
  `devTmuxArgs`; a bare `tmux` reaches the human's own sessions. Only the
  worktree-cleanup readiness check (to list panes) and the legacy-stack guard in
  `dev-tmux.ts` (a read-only `has-session`) read the human's server.
- Portless's proxy port comes only from `resolvePortlessProxyPort` in
  `portless-routes.ts`. Route expectations, readiness, the internal SSR API
  origin and `./mf` all pass that value; never hard-code a port, and leave
  default-443 URLs bare.
- `DEV_DATABASES` in `lib/dev-env.ts` is the only database registry. Resolve
  worktree URLs through `applyDevEnvToProcess()` and administer databases
  through `lib/dev-db.ts`. Never regex-edit a URL, fall back to a shared
  database, or open an ad-hoc admin client.
- `meridian-dev-postgres-1` serves every worktree on the machine: test compose
  changes under another project name and port, never recreate it from a branch you
  are still checking. Only `pnpm dev:infra:upgrade`, run from a checkout that has
  merged `main`, moves it to a new image
  ([DEVELOPMENT.md](../../DEVELOPMENT.md)); `pnpm dev:infra` and bootstrap start a
  missing server and never touch a running one.
- Change schemas with `pnpm db:generate` plus `pnpm db:reset`, never `push`.
  The pre-deploy baseline rule is in [database guidance](../../packages/database/AGENTS.md).
- No secret value appears in the tmux command, stdout or
  `.meridian/dev-session.json`: services get secrets from `with-dev-env.ts`,
  which loads them at startup. Keep the pane's exports non-secret and inside
  the subshell. Report `started` only after readiness and
  verified routes pass.
- Stop and clean up by target. Never stop dev servers by pattern
  (`pkill -f "pnpm dev"`, `killall node` match every worktree's stack), never
  reset all Tailscale routes, and never infer staleness from a branch name.
  Cleanup removes only what it can prove is merged; when it refuses a branch
  you believe is safe, follow [`WORKTREE-CLEANUP.md`](WORKTREE-CLEANUP.md).
- Orphan teardown requires path/pane ownership and process identity, never cwd
  or a name prefix alone. Inspect orphans with
  `pnpm dev:prune-worktrees -- --orphans --dry-run`.
- Scripts run under `bun` (`#!/usr/bin/env bun`, `bun tools/dev/x.ts` in `package.json`), not
  tsx. Bun is pinned in `.tool-versions`. Vite, Nitro and Vitest stay on Node: don't use
  `bunx --bun` for them.
- **Bun runs our own tooling; anything that runs server or app code stays on Node**
  (Nitro, Vite, or `apps/server/server/...` imported in-process), because production is Node
  and those runs are its evidence. So the probes, `apps/server/scripts`, `models:refresh`,
  `smoke:project-domain`, `tests/smoke` and the tests that start server code use `tsx` (a root
  dev dependency) or plain `node`; `tools/qa/shared-db-server.ts` is a Bun launcher whose Nitro
  and Vite children (`shared-db-serve.mjs`) run on Node. Nitro fails on Bun (crossws).
- `tools/mf` and `apps/app/e2e` import the Portless helpers
  ([the list](../mf/AGENTS.md)). Keep those free of import-time side effects, with
  Node built-ins as their only runtime dependencies.
- DB tests use owned databases and rollback or FK-ordered reset. Never add
  per-case truncation or share a managed database between workers.
- Keep `pnpm dev:production-client`'s API and WebSocket ownership in the app
  launcher; do not add a second route inventory here.

## Idle stacks and memory

A stack costs 1.5–3.5 GB, so forgotten ones exhaust the machine. `pnpm dev:stacks`
lists every checkout's stack with its memory and idle time. Each stack runs a watcher
(`dev-idle-watch.ts`, tmux window `idle-watch`) that stops it with `pnpm dev --stop`
after `DEV_IDLE_STOP_MINUTES` (default 60, `0` turns it off) without work; the next
`pnpm dev` starts it cleanly. "Work" is the stack's process tree burning CPU (summed per
pid), which a page load, an `./mf` call or an edit does and an untouched stack does not;
pane output does not track use. `lib/dev-idle.ts` holds the rule, and
`pnpm dev:stacks --reap-idle <minutes>` uses it too.

- **The mark lives on the tmux session** (user option `@last-active`), so it dies with
  the stack. A stack with no live `idle-watch` window shows `unwatched` (started with
  `0`, watcher crashed, or started before the watcher existed) and is never reaped:
  restart it to get a watcher.
- **The watcher runs under `bun`**, ~20 MB resident; under tsx it was ~360 MB and under
  plain `node` ~60 MB. It lives as long as the stack, so keep it light: a few `node:` imports,
  no workspace packages.
- **Why a stack stopped:** the watcher logs the `--stop` outcome to `logs/dev-idle-stop.log`
  and leaves `.meridian/dev-idle-stopped`; `pnpm dev` prints and clears it, and
  `pnpm dev:stacks` and `./mf` print it while the stack is down.

Don't stop a stack you didn't start. `pnpm dev` also warns, never blocks, and lists the
stacks when `MemAvailable` is under `DEV_LOW_MEMORY_GB` (default 8).

## Cleaning up

1. Stop the dev stack with `pnpm dev --stop`.
2. End anything still running from the checkout: the Nx daemon, `agent-browser`
   sessions, watchers.
3. Remove the worktree, its database and its merged branch with
   `pnpm dev:prune-worktrees -- --target <branch|path>`, `--dry-run` first. Run it
   in the foreground and read its exit. Don't wait on it with
   `until ! pgrep -f "prune-worktrees..."`: the pattern matches the waiting shell's own
   command line, so the loop never ends.
4. For a detached checkout the tool refuses, run `pnpm dev --stop` in it, then
   `git worktree remove` it, and drop its database with `pnpm dev:gc-dbs`.

Run `pnpm dev:gc-dbs` after a batch of cleanups.

A worktree's database is named from its branch. After switching a worktree's branch,
restart its stack (`pnpm dev:restart`): the running stack keeps the old branch's database,
which no name claims once it stops.

Contracts for databases, sessions, cleanup evidence and migrations:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
