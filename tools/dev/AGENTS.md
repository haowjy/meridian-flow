# tools/dev — Agent Rules

Local-development utilities only; production runtime must not import this
module. Reusable contracts and command semantics live in
[`.context/CONTEXT.md`](.context/CONTEXT.md).

## Ownership

This directory owns environment and per-worktree database setup, migrations and
SQL-function sync, `pnpm dev` orchestration, readiness and Tailscale lifecycle,
managed DB tests, worktree cleanup, migration lint/history checks, bootstrap,
and the `./mf` API wrapper.

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
- `pnpm dev --stop` and worktree pruning are targeted. Cleanup must preserve
  live listeners and use surgical Tailscale `off`; never reset all routes or
  infer staleness from a branch name.
- `./mf` wraps debug-gated API routes and owns no business logic or Postgres
  reads. If it needs data, add a server debug route rather than a CLI query.
- Keep TypeScript inside the directory's strict Nx boundary and do not import
  application packages, except `@meridian/contracts` from `cli/`.
- DB tests use owned databases and rollback/FK-ordered reset; never add per-case
  truncation or share a managed database between workers.

See the context page for CLI output, DB lifecycle, cleanup evidence, and probe
contracts.
