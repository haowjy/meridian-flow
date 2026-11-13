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
- Change schemas with `pnpm db:generate` plus `pnpm db:migrate`, never `push`. Migration lint
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
- Orphan teardown requires path/pane ownership and process identity, never cwd
  or a name prefix alone. Inspect orphans with
  `pnpm dev:prune-worktrees -- --orphans --dry-run`.
- `tools/mf` and `apps/app/e2e` import the Portless helpers
  ([the list](../mf/AGENTS.md)). Keep those free of import-time side effects, with
  Node built-ins as their only runtime dependencies.
- DB tests use owned databases and rollback or FK-ordered reset. Never add
  per-case truncation or share a managed database between workers.
- Keep `pnpm dev:production-client`'s API and WebSocket ownership in the app
  launcher; do not add a second route inventory here.

## Cleaning up

1. Stop the dev stack with `pnpm dev --stop`.
2. End anything still running from the checkout: the Nx daemon, `agent-browser`
   sessions, watchers.
3. Remove the worktree, its database and its merged branch with
   `pnpm dev:prune-worktrees -- --target <branch|path>`, `--dry-run` first.
4. For a detached checkout the tool refuses, run `pnpm dev --stop` in it, then
   `git worktree remove` it, and drop its database with `pnpm dev:gc-dbs`.
5. On `main` after a PR merges, `git rm -r .github/pr-assets/<dir>` and commit. PR
   bodies link each image at a commit, so the images stay readable.

Run `pnpm dev:gc-dbs` after a batch of cleanups.

A worktree's database is named from its branch. After switching a worktree's branch,
restart its stack (`pnpm dev:restart`): the running stack keeps the old branch's database,
which no name claims once it stops.

Contracts for databases, sessions, cleanup evidence and migrations:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
