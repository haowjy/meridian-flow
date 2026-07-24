# tools/dev — Agent Rules

Local-dev-only utilities. Never imported by the application runtime.

→ Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

## What this module owns

- Dev env resolution (`.env` loading + per-worktree rewrite of every registered DB URL)
- Per-worktree Postgres DB administration (ensure / drop / extensions / reserved guards)
- Per-run local DB test provisioning, ownership, cleanup, and stale-run GC
- Schema application via `drizzle-kit migrate` (`prepare-db.ts`)
- `pnpm dev` orchestration (tmux + portless + dev modes + readiness + tailscale)
- Dev session planning (canonical env, redacted commands, internal API origin)
- Tailscale serve/funnel lifecycle (stale route pruning, verified external routes)
- Worktree cleanup (`pnpm dev:prune-worktrees`)
- Migration SQL linting (`migration-lint.ts`, CI/pre-commit gate policy)
- `pnpm bootstrap` and dev-data seeding

## Rules

- **`DEV_DATABASES` (in `lib/dev-env.ts`) is the single source of truth.** To add or change a per-worktree database, edit the registry — never hard-code a second database, env var, or `"web"` special-case in `ensure-db`, `drop-db`, `prepare-db`, `.envrc`, or anywhere else. Every consumer iterates the registry.
- **Non-interactive shells bypass direnv.** `.envrc` rewrites `DATABASE_URL` to the worktree-scoped database, but agent shells and non-interactive sessions do not execute `.envrc`. In those environments `DATABASE_URL` resolves to the shared `meridian` database, so migration, test, and admin commands silently target the wrong DB. Agents must derive the worktree DB explicitly — run `pnpm bootstrap` (which calls `applyDevEnvToProcess`) or source `print-worktree-env.ts` output before any database operation.
- **Use `lib/dev-env.ts` for env loading.** Do not call `process.loadEnvFile` or write a bespoke `loadEnvFromFile`. The canonical entry point is `applyDevEnvToProcess()`.
- **Use `lib/dev-db.ts` for DB admin.** Do not open a fresh `pg.Client` and run `CREATE`/`DROP`/`CREATE EXTENSION` from a new script — extend the helpers in `lib/dev-db.ts` and add a thin CLI wrapper.
- **No regex URL surgery.** Transformations on a database URL use `new URL()` and rewrite `pathname` specifically. The worktree name is always `<baseDbName>_<slug>` (derived from the URL's own base name), and the rewrite must stay idempotent.
- **Silent fallback is forbidden in worktree mode.** If a tool cannot derive the worktree-scoped DB, it must throw/exit loudly. Silent fallback to a shared DB would re-introduce the cross-worktree blast radius.
- **`drop-db` must always go through `isReservedDatabase`** against the full set of main-checkout DB names. New "main-like" databases get protected by extending `RESERVED_DATABASES` in `lib/dev-db.ts` (or the registry), not by patching the CLI.
- **Schema changes use `generate` + `migrate`, not `push`.** `dev`/`bootstrap` apply committed migrations via `prepare-db.ts`; `db:push` is for disposable local experiments only and never carries `--force`.
- **Migration-lint policy is explicit.** Errors always block; warnings block only
  under `--strict` (CI PRs to `main`/`staging`). `--changed <ref>` scopes PR lint,
  `--staged` powers pre-commit, and `0000_` is the warning-exempt baseline.
- **New DB-shape contracts get tests.** Slug-rewrite, name-validation, idempotency, and reserved-name behavior are covered by `__tests__/dev-env.test.ts` and `__tests__/dev-db.test.ts`. Add cases when you change those contracts.
- **Dev stack cleanup is targeted.** Use `pnpm dev --stop` to stop this worktree's dev tmux session(s) and prune portless routes. Tailscale cleanup is surgical per-route `off` only; never use `tailscale serve reset`, and never remove routes whose local target is still listening.
- **Restart never claims ownership by port.** It may terminate the worktree's owned tmux session, then wait for its fixed ports. A remaining or uninspectable holder aborts startup with diagnostics; port discovery must never authorize signaling a process.
- **Command construction: canonical env first.** `applyDevEnvToProcess(repoRoot)` must run _before_ `createDevSessionCommand` — the tmux command must consume resolved worktree-scoped URLs, never ambient `.env` + ad-hoc pass-through. The call order in `dev-tmux.ts` is the canonical pattern; do not invert it.
- **Secrets stay in tmux only.** `DevSessionCommand.executable` (the shell command sent to tmux) may contain raw secrets. `DevSessionCommand.display` is redacted (`redactEnvValue` in `dev-session-plan.ts`). Only `display` is printed to stdout or persisted in `.meridian/dev-session.json`. Never add a new metadata field that contains raw secrets.
- **Readiness gates before `started`.** `pnpm dev` reports `started` only after portless route checks _and_ real HTTP probes (`waitForDevReadiness`). Never print URLs that haven't been verified reachable. When adding a new service, add a `targetsForOrigins` entry.
- **The app boot smokes own their evidence.** The dev-transform and production-artifact gates probe only the spawned child's reported origin while that child is alive. Keep their shared exact route contract in `lib/app-boot-contract.ts`: `/` is 307; `/login` is 200 with the Meridian login marker. The production gate must run the app package's real `build` and validated `start` scripts with child-only fake config. A foreign listener or generic non-5xx response is not success.
- **Failure output points to evidence.** Startup failures must print the repository-relative `logs/portless.log` path; pre-launch port refusals also identify the holder by PID and command.
- **Tailscale routes: verified before printed.** External URLs appear in `pnpm dev` output only after `verifyTailscaleExternalRoutes` confirms the expected binding exists. Add a `hasExpectedBinding` check for new shared services. Never print a Tailscale URL before the binding is confirmed.
- **Worktree cleanup separates authorization from auto readiness.** `pnpm dev:prune-worktrees` binds ref-deletion eligibility to the planned branch OID and revalidates it before every action. `--auto` additionally requires an exact merged PR plus a clean, unowned, inactive worktree; it rechecks those gates before teardown. Keep authorization in `lib/worktree-cleanup-eligibility.ts`, readiness in `lib/worktree-cleanup-readiness.ts`, orchestration in `prune-worktrees.ts`, and actions in `lib/worktree-cleanup.ts`; never infer staleness from branch ancestry or a branch name.
- **All TypeScript here stays inside one strict Nx boundary.** `tools/dev/project.json` registers `meridian-dev-tools:typecheck`; `tools/dev/tsconfig.json` includes the directory. Do not add per-script typecheck wrappers or weaken strictness.
- **Surgical Tailscale cleanup in pruning.** Stale route removal goes through `findStaleTailscaleRoutes` + `tailscaleRouteOffArgs` (per-port `off`). Never call `tailscale serve reset` or `tailscale funnel reset`. Never prune a route with any live listener.
- **WS 426 is not a warning.** Plain HTTP hits to `/api/threads/ws` and `/ws/yjs` produce expected 426 responses. `routeStatusEvent` in `apps/server/server/lib/request-observability.ts` suppresses these. When adding a new WebSocket route, add it to `isExpectedWsPlainHttpStatus`.

## Do not

- Do not run `tools/dev/*` scripts from production code or app runtime
- Do not import from `apps/`, `packages/`, or `python/` — these are dev tools, not app code
- Do not depend on Node modules outside the root `package.json`'s devDependencies
- Do not print or persist the `executable` command — stdout, logs, and `.meridian/dev-session.json` get `display` (redacted) only
- Do not build the tmux command before calling `applyDevEnvToProcess`
- Do not add new cleanup scripts that bypass `lib/worktree-cleanup.ts`; extend the resolver instead
- Do not add a `tailscale serve reset` call — all cleanup is surgical per-port `off`
- Do not report `started` until all readiness gates pass (portless routes + server `/readyz` + app origin + tailscale route verification)
