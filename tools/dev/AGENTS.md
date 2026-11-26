# tools/dev

Local-development utilities. Production code never imports this directory, and
this directory never imports application packages. The `./mf` CLI lives in
[`tools/mf`](../mf/AGENTS.md).

## Rules

- A checkout's ports have one source: `DEV_PORT_BASE` in its `.env.local`, read by
  `resolveDevPorts` in `lib/dev-ports.ts`, which writes the line the first time a
  worktree is asked. To move a stack, change that line. Never hard-code a port, read one
  from the shell, or pick a free one at start.
- Code that talks to a stack finds it through its record: `requireRunningStack` or
  `runningStack` in `lib/dev-stack.ts`, as `./mf` and the browser tests do. Only code
  that starts a stack, or must stay off its ports, calls `resolveDevPorts`.
- `isMainCheckout` in `lib/checkout.ts` is the one test for the main checkout.
- Only the supervisor publishes a stack on the tailnet (`lib/dev-tailscale.ts`), and it
  removes only routes that point at its own ports. Never run `tailscale serve reset`,
  and never replace a route that points anywhere else.
- A stack is found and stopped through its record, `.meridian/dev-stack.json`
  (`lib/dev-stack.ts`): the supervisor's pid plus its `ps` start time. `runningStack`
  treats a record whose start time doesn't match as stale, and every signal checks the
  target's start time first, so a reused pid is not signalled.
- `DEV_DATABASES` in `lib/dev-env.ts` is the only database registry. Resolve
  worktree URLs through `applyDevEnvToProcess()` and administer databases
  through `lib/dev-db.ts`. Never regex-edit a URL, fall back to a shared
  database, or open an ad-hoc admin client.
- `meridian-dev-postgres-1` serves every worktree on the machine: test compose
  changes under another project name and port, never recreate it from a branch you
  are still checking. Only `pnpm dev:infra:upgrade`, run from a checkout that has
  merged `main`, moves it to a new image
  ([DEVELOPMENT.md](../../DEVELOPMENT.md)); `pnpm dev`, `pnpm dev:infra` and bootstrap
  start a missing server and never touch a running one.
- Change schemas with `pnpm db:generate` plus `pnpm db:reset`, never `push`.
  The pre-deploy baseline rule is in [database guidance](../../packages/database/AGENTS.md).
- No secret value appears in a command line, stdout or `.meridian/dev-stack.json`.
  The supervisor loads `.env` when it starts the services and passes it only through
  their environment. Report `started` only after the server's `/readyz` and the app
  answer.
- Stop by recorded pid. Never stop dev servers by pattern (`pkill -f "pnpm dev"`,
  `killall node` match every worktree's stack) or by whatever holds a port.
- `lib/checkout.ts`, `dev-ports.ts`, `dev-stack.ts` and `dev-tailscale.ts` are imported
  by `tools/mf`, `playwright.config.ts`, `apps/app/e2e` and `tools/qa`. Keep them free of
  import-time side effects, with Node built-ins as their only runtime dependencies.
- Scripts run under `bun` (`#!/usr/bin/env bun`, `bun tools/dev/x.ts` in `package.json`), not
  tsx. Bun is pinned in `.tool-versions`. Vite, Nitro and Vitest stay on Node: don't use
  `bunx --bun` for them.
- **Bun runs our own tooling; anything that runs server or app code stays on Node**
  (Nitro, Vite, or `apps/server/server/...` imported in-process), because production is Node
  and those runs are its evidence. So the probes, `apps/server/scripts`, `models:refresh`,
  `smoke:project-domain`, `tests/smoke` and the tests that start server code use `tsx` (a root
  dev dependency) or plain `node`; `tools/qa/shared-db-server.ts` is a Bun launcher whose Nitro
  and Vite children (`shared-db-serve.mjs`) run on Node. Nitro fails on Bun (crossws).
- DB tests use owned databases and rollback or FK-ordered reset. Never add
  per-case truncation or share a managed database between workers.
- Keep `pnpm dev:production-client`'s API and WebSocket ownership in the app
  launcher; do not add a second route inventory here.

## The supervisor

`pnpm dev` starts `dev-supervisor.ts` detached, in a session of its own, and returns
once the stack answers. The supervisor runs each service with `pnpm --filter <pkg> dev`
and sends their output to `logs/dev.log`.

- **It finds its services by parentage, not process group.** pnpm starts each script in
  a group of its own, so `processTree` walks parent pids from `ps`. Take the tree before
  signalling: a process whose parent has exited is reparented and drops out of it.
- **It stops the whole stack** when a service exits, when the checkout's `.git` is gone
  (checked every 15 s), and after `DEV_IDLE_STOP_MINUTES` (default 60, `0` turns it off)
  without work. "Work" is the service processes burning CPU, summed per pid, which a
  page load, an `./mf` call or an edit does and an untouched stack does not.
- **`pnpm dev:restart` sends it `SIGUSR2`.** It restarts the services with the
  environment it was started with and reads `.env` again. That is why a stack started
  with `MODEL_PROVIDER=mock` stays on the mock: nothing stores the values, the
  supervisor still holds them.
- **Why a stack stopped:** the reason is the last `[dev]` line in `logs/dev.log`. An
  idle stop also leaves `.meridian/dev-idle-stopped`; `pnpm dev` prints and clears it,
  and `./mf` prints it while the stack is down.
- **CPU time comes from `ps` on macOS and `/proc/<pid>/stat` on Linux**, where `ps`
  reports whole seconds, too coarse to tell an idle stack from a used one.

A stack costs 1.5–3.5 GB, so forgotten ones exhaust the machine. `pnpm dev:stacks`
lists every checkout's stack with its memory and idle time. Don't stop a stack you
didn't start.

## Cleaning up

1. End anything still running from the checkout: the Nx daemon, `agent-browser`
   sessions, watchers. The dev stack stops itself once the checkout is gone;
   `pnpm dev --stop` stops it now.
2. Remove the worktree, its merged branch and its database with `wt remove <branch>`
   from another checkout. The `post-remove` hook in `.config/wt.toml` runs
   `pnpm dev:gc-dbs -- --yes`.
3. After removing a worktree any other way, run `pnpm dev:gc-dbs -- --yes`.

A worktree's database is named from its directory (`meridian_<directory name>`), so it
stays the same whatever branch is checked out there. Two worktrees whose directories
share a name would share a database; every dev command in either refuses to run until
one is moved.

Contracts for databases, sessions, cleanup evidence and migrations:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
