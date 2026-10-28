# tools/dev

Local-development utilities: per-worktree environment and databases,
migrations and SQL-function sync, `pnpm dev` orchestration with readiness and
Tailscale, managed DB tests, worktree cleanup, migration lint and history
checks, and bootstrap. Production code never imports this directory, and this
directory never imports application packages. The `./mf` CLI lives in
[`tools/mf`](../mf/AGENTS.md).

## Rules

- Dev sessions live on the private tmux socket in `lib/dev-tmux-socket.ts`
  (`-L meridian-flow-dev`). Build every dev-session tmux call from
  `devTmuxArgs`; a bare `tmux` reaches the human's own sessions. Only the
  worktree-cleanup readiness check reads the human's server, and only to list
  panes.
- `DEV_DATABASES` in `lib/dev-env.ts` is the only database registry. Resolve
  worktree URLs through `applyDevEnvToProcess()` and administer databases
  through `lib/dev-db.ts`. Never regex-edit a URL, fall back to a shared
  database, or open an ad-hoc admin client.
- Change schemas with `generate` plus `migrate`, never `push`. Migration lint
  has one `RULES` list; a skip must be safe on populated tables.
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
- `pnpm dev` sweeps managed sessions for missing checkouts before start/reuse,
  but never for `--print` or `--stop`. Inspect them with
  `pnpm dev:prune-worktrees -- --orphans --dry-run`. Orphan teardown requires
  path/pane ownership and process identity, never cwd or a name prefix alone.
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
