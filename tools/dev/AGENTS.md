# tools/dev — Agent Rules

Local-development utilities only; production runtime must not import this
module. Reusable contracts and command semantics live in
[`.context/CONTEXT.md`](.context/CONTEXT.md).

## Ownership

This directory owns environment and per-worktree database setup, migrations and
SQL-function sync, `pnpm dev` orchestration, readiness and Tailscale lifecycle,
managed DB tests, worktree cleanup, migration lint/history checks, and
bootstrap. The `./mf` CLI lives in [`tools/mf`](../mf/AGENTS.md).

## Rules

- `DEV_DATABASES` in `lib/dev-env.ts` is the only database registry. Resolve
  worktree URLs through `applyDevEnvToProcess()` and administer databases through
  `lib/dev-db.ts`; never regex-edit URLs, silently fall back to a shared DB, or
  open an ad-hoc admin client.
- Use `generate` plus `migrate`, not `push`, for schema changes. The migration
  runner owns frozen history, advisory locking, and no-transaction semantics;
  only reset the current checkout's database with explicit ownership.
- Migration lint has one `RULES` list. Errors always block; warnings block in
  strict CI. Skips must be safe on populated tables.
- Build canonical environment before the tmux command. Secrets may enter the
  executable sent to tmux but only its redacted display form may reach stdout or
  `.meridian/dev-session.json`. Readiness and verified external routes precede
  reporting `started` or printing URLs.
- `pnpm dev --stop` and worktree pruning are targeted. Never stop dev servers
  by pattern (`pkill -f "pnpm dev"`, `killall node`): it matches every
  worktree's stack. Cleanup must preserve
  live listeners and use surgical Tailscale `off`; never reset all routes or
  infer staleness from a branch name. Cleanup authorizes only the planned
  commit: contained in another surviving ref, or one exact merged PR; batch
  cleanup narrows to the exact PR into the detected base. Cleanup executes one
  run at a time per repository, refusing a stale lock rather than taking it
  over.
- `tools/mf` consumes `portless-prefix.ts`, `portless-routes.ts`,
  `portlessCa` in `dev-readiness.ts` and `resolveCheckoutRouteUrls` in
  `dev-session-state.ts`, and `apps/app/e2e` consumes
  `portless-prefix.ts`. Keep them free of import-time side effects, with
  Node built-ins as their only runtime dependencies.
- Keep TypeScript inside the directory's strict Nx boundary and do not import
  application packages.
- DB tests use owned databases and rollback/FK-ordered reset; never add per-case
  truncation or share a managed database between workers.

- The dev server doesn't watch `node_modules`: pnpm hardlinks its shared store
  into every worktree, so another worktree's install would restart this one's
  server and kill in-flight replies
  ([#817](https://github.com/haowjy/meridian-flow/issues/817)).
- Dev stacks are the largest memory consumer on a shared host (measured
  2026-10: 14.9 GB across six worktrees, one active stack 6.6 GB, against ~9 GB
  for every test process). `pnpm dev:stacks` reports each stack's memory and
  idle time; `--reap-idle <minutes> --yes` stops stale ones.
- Prune a lane by containment in its integration branch or by its own merged
  PR. Containment disappears when that ref is deleted: once an integration
  branch is squash-merged and deleted without the lane having its own PR, only
  a human who tracked the history can confirm the lane is safe to remove.

See the context page for CLI output, DB lifecycle, cleanup evidence, and probe
contracts.
