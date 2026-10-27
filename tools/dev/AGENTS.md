# tools/dev

Local-development utilities: per-worktree environment and databases,
migrations and SQL-function sync, `pnpm dev` orchestration with readiness and
Tailscale, managed DB tests, worktree cleanup, migration lint and history
checks, and bootstrap. Production code never imports this directory, and this
directory never imports application packages. The `./mf` CLI lives in
[`tools/mf`](../mf/AGENTS.md).

## Rules

- Portless's proxy port comes only from `resolvePortlessProxyPort` in
  `portless-routes.ts`. Route expectations, readiness, the internal SSR API
  origin and `./mf` all pass that value; never hard-code a port, and leave
  default-443 URLs bare.
- `DEV_DATABASES` in `lib/dev-env.ts` is the only database registry. Resolve
  worktree URLs through `applyDevEnvToProcess()` and administer databases
  through `lib/dev-db.ts`. Never regex-edit a URL, fall back to a shared
  database, or open an ad-hoc admin client.
- Change schemas with `generate` plus `migrate`, never `push`. Migration lint
  has one `RULES` list; a skip must be safe on populated tables.
- Secrets may reach the command sent to tmux, never stdout or
  `.meridian/dev-session.json`. Report `started` only after readiness and
  verified routes pass.
- Dev stacks run on the private tmux server `meridian-dev`, named once in
  `lib/dev-tmux-server.ts`, never on the default server, which holds the machine
  owner's live shells. Attach with
  `tmux -L meridian-dev attach -t <session>`. Cleanup readiness also lists panes
  on the default server, read-only, so a shell parked there still blocks removal.
- A session must not trust its pane's cwd: tmux ignores `new-session -c` once the
  server's cwd has been deleted, and the server outlives the worktree that
  started it. The launch command begins with `cd <checkout> &&`, and tmux clients
  run from `$HOME` so a new server never holds a worktree's cwd.
- Stop and clean up by target. Never stop dev servers by pattern
  (`pkill -f "pnpm dev"`, `killall node` match every worktree's stack), never
  reset all Tailscale routes, and never infer staleness from a branch name.
  Cleanup removes only what it can prove is merged; when it refuses a branch
  you believe is safe, follow [`WORKTREE-CLEANUP.md`](WORKTREE-CLEANUP.md).
- `pnpm dev` sweeps managed sessions on `meridian-dev` for missing checkouts
  before start/reuse, but never for `--print` or `--stop`, and the sweep never
  touches the default tmux server. Inspect them with
  `pnpm dev:prune-worktrees -- --orphans --dry-run`. Orphan teardown requires
  path/pane ownership and process identity, never cwd or a name prefix alone. A
  dead pane (`remain-on-exit`) has no process or cwd to check: skip it, never
  signal its PID.
- `tools/mf` and `apps/app/e2e` import the Portless helpers
  (`portless-prefix.ts`, `portless-routes.ts`, `dev-readiness.ts`,
  `dev-session-state.ts`). Keep those free of import-time side effects, with
  Node built-ins as their only runtime dependencies.
- DB tests use owned databases and rollback or FK-ordered reset. Never add
  per-case truncation or share a managed database between workers.
- The dev server doesn't watch `node_modules`; run `pnpm dev:restart` after an
  install.
- `pnpm dev:production-client` replaces only the Vite app process with a fresh
  production build and a same-origin gateway. The server and database remain
  the normal checkout-scoped dev stack. Keep its API and WebSocket ownership in
  the app launcher; do not add a second route inventory here.
- Dev stacks use more memory than the tests. `pnpm dev:stacks` reports each
  stack's memory and idle time.

Contracts for databases, sessions, cleanup evidence and migrations:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
