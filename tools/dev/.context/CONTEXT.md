# tools/dev — Dev tooling

Local-dev-only utilities. Not loaded by the application runtime.

**Onboarding:** [DEVELOPMENT.md](../../../DEVELOPMENT.md). **Rules when editing this module:** [AGENTS.md](../AGENTS.md).

## What this module owns

- **Environment resolution** — `lib/dev-env.ts` (`DEV_DATABASES`, worktree URL rewrite, `applyDevEnvToProcess`, `ensureDirenvAllowed`)
- **Database admin** — `lib/dev-db.ts` (ensure/create/drop/reset against local Postgres)
- **Infra lifecycle** — `lib/dev-infra.ts` + `docker-compose.yml` (`postgres:16` on `:54422`)
- **Schema application** — `bootstrap.ts`, `prepare-db.ts` (migrate + `db:apply-functions`)
- **Dev orchestration** — `dev-tmux.ts` (worktree-scoped tmux + portless routes)
- **Session planning** — `dev-session-plan.ts` (canonical env, redacted commands, internal API origin)
- **Readiness** — `dev-readiness.ts` (real HTTP probes before reporting started)
- **Tailscale lifecycle** — `lib/tailscale-lifecycle.ts` (stale route pruning, verified external routes)
- **Worktree cleanup** — `lib/worktree-cleanup.ts` + `prune-worktrees.ts` (merged-branch resource teardown)

## Directory layout

```
tools/dev/
├── lib/
│   ├── dev-env.ts             DEV_DATABASES registry + worktree URL rewrite
│   ├── dev-db.ts              CREATE/DROP/EXTENSION admin
│   ├── test-db-lifecycle.ts   Per-run DB test identity + owner liveness
│   ├── dev-infra.ts           DB preflight + migration drift check
│   ├── dev-share-ports.ts     Deterministic Tailscale/backend port assignment per worktree
│   ├── tailscale-lifecycle.ts Stale route pruning + external route verification
│   ├── tailscale-external-routes.ts  Pure policy: verify expected bindings
│   ├── tailscale-stale-routes.ts     Parse serve/funnel status; find dead-target routes
│   ├── migration-state.ts     Expected vs applied migration hash drift detection
│   ├── app-boot-contract.ts   Exact child-owned smoke route contract
│   ├── app-boot-smoke.ts      Shared child lifecycle + route probe harness
│   ├── worktree-cleanup-eligibility.ts  Commit-bound cleanup authorization
│   ├── worktree-cleanup-readiness.ts  Auto cleanup ownership/liveness gates
│   └── worktree-cleanup.ts    Cleanup resolver + execution engine
├── docker-compose.yml
├── bootstrap.ts               pnpm bootstrap
├── dev-tmux.ts                pnpm dev entry point (thin — see session plan, readiness, tailscale)
├── dev-session-plan.ts        Session command construction + redaction + internal API origin
├── dev-readiness.ts           HTTP readiness probes (server /readyz + app origin)
├── dev-output.ts              Structured startup / failure output
├── dev-mode.ts                CLI arg parsing + mode detection (local/tailscale/funnel)
├── dev-app-env-passthrough.ts App env key allowlist for tmux command
├── ensure-db.ts / prepare-db.ts / drop-db.ts / reset-db.ts
├── smoke-app-dev-transform.ts  Vite dev transform/render boot gate
├── smoke-app-prod-boot.ts      Production build + Nitro boot gate
├── run-db-tests.ts             Owned local DB lifecycle + shared Vitest suite
├── gc-dbs.ts                  Stale worktree database cleanup
├── print-worktree-env.ts      eval'd by .envrc
├── portless-routes.ts / portless-prefix.ts / session-identity.ts / tmux-session-store.ts
├── prune-worktrees.ts         Merged worktree + branch + DB + work-item cleanup
├── migration-lint.ts
├── project.json               Nx project; exposes the tools typecheck target
└── tsconfig.json              Canonical strict TypeScript boundary for this directory
```

## Environment contract

- **`DEV_DATABASES`** (`lib/dev-env.ts`) is the single registry — consumers iterate it; never hard-code a second DB env var.
- Main-checkout **`.env`** is loaded via `loadMainEnvFile`; linked worktrees rewrite registered URLs to `<baseDbName>_<slug>` (idempotent; no silent fallback to shared `meridian`).
- **`.envrc`** → `print-worktree-env.ts`; **`applyDevEnvToProcess`** applies the same rewrite for pnpm scripts.

## Database contract

- One Postgres server (`:54422`), many databases. Main checkout: **`meridian`** (reserved). Worktrees: **`meridian_<slug>`**.
- **Garbage collection:** `pnpm dev:gc-dbs -- --yes` considers every database prefixed by a registered main-checkout name (for example, `meridian_*`). It preserves live worktrees, active managed test runs, explicit `<base>_test-manual-*` databases, and reserved names. It drops stale worktree databases and managed test databases whose owner process has stopped.
- **DB test lifecycle:** against local Postgres, `pnpm test:db` creates and migrates a unique `<base>_test-run-<pid>-<timestamp>` database, runs the shared Vitest project, and drops only that owned database. The nested fresh-migration proof uses the existing `<base>_migrations_<pid>_<timestamp>` managed convention. CI/external Postgres instances rely on their own pre-provisioned ephemeral database. A killed local run is reclaimed later by `dev:gc-dbs` only when its encoded owner PID is no longer alive. Managed and manual test prefixes are reserved from worktree database slugs.
- **`drop-db`** refuses reserved/main-checkout names. Use **`db:reset`** (schema-only) rather than dropping `meridian`.
- **Reset:** `db:reset` — drop/recreate `public` + `drizzle` on the active DB, then `prepare-db`.
- **Full wipe:** `dev:infra:down`, remove `meridian-dev_meridian-postgres-data` volume, `bootstrap`.

## Session planning contract

`dev-session-plan.ts` separates **what to run** from **what to print/persist**:

- **Canonical env before construction.** `applyDevEnvToProcess(repoRoot)` runs before `createDevSessionCommand`, so the tmux command consumes resolved worktree-scoped URLs — never ambient `.env` + ad-hoc pass-through. `dev-tmux.ts` preserves that ordering without tying the contract to source line numbers.
- **Executable vs display.** `createDevSessionCommand` returns a `DevSessionCommand`: `executable` (may contain secrets, sent to tmux only), `display` (redacted, printed to stdout and persisted in metadata), and `internalApiOrigin` (used by app SSR).
- **Redaction.** `redactEnvValue` replaces `DATABASE_URL` with `<postgres:host/dbname>`, API keys and cookie passwords with `<redacted>`, and `WORKOS_DEV_LOGIN_EMAIL` with `<redacted>`. Portless env keys (`PORTLESS_*`) and non-sensitive app config pass through unredacted.
- **Metadata** (`.meridian/dev-session.json`) stores the **display** command only. The `DevSessionMetadata.command` field is redacted; the executable command is never persisted. External routes are verified before being written.
- **Internal API origin.** `resolveInternalApiOrigin` produces a worktree-prefixed `https://<prefix>.server.meridian.localhost`. This is the paired server origin for SSR API calls — the app never self-proxies through the public Tailnet app URL. Exposed on `DevSessionCommand.internalApiOrigin`; injected as `MERIDIAN_API_ORIGIN` in the tmux command's pass-through exports.
- **`--print`** dry-run uses the **display** command only.

## Dev server contract

- Portless-first — `pnpm portless:list` is the URL source of truth; no raw localhost port assumptions in new dev tools.
- **Readiness gates.** `pnpm dev` reports `started` only after three gates pass:
  1. Portless routes present and PIDs registered (`readPortlessState` → `validateExpectedRoutes`)
  2. Server `/readyz` returns 200 and app origin returns 200 or 3xx (`waitForDevReadiness`, HTTP probes via portless CA)
  3. Tailscale external routes verified against `tailscale serve status --json` (`TailscaleDevLifecycle.ensureExternalRoutes`)
  If any gate fails, the script exits with an actionable message and prints the repository-relative `logs/portless.log` path — never prints URLs the app can't reach.
- **App boot ownership and routes.** `smoke-app-dev-transform.ts` and `smoke-app-prod-boot.ts` trust only the spawned child's reported origin, check that child remains alive, and apply `lib/app-boot-contract.ts`: `/` must return 307; `/login` must return 200 with the Meridian login-page marker. The production gate runs the package's real `build` and validated `start` scripts with fake config scoped to its child. A foreign listener or merely non-5xx response is not success.
- **Verified Tailscale external routes.** External URLs are only printed after `verifyTailscaleExternalRoutes` confirms the expected `serve`/`funnel` binding exists in `tailscale serve status --json`. An unverified route is treated as a startup failure.
- **Shared service ports** are deterministic per worktree (`lib/dev-share-ports.ts`): app backend ports in `[37000, 45000)`, Tailscale HTTPS ports in `[47000, 55000)`, funnel ports are fixed (`443`, `8443`). Hash-based collision avoidance across worktrees.
- `pnpm dev` → worktree-scoped tmux session; `--stop` / `--restart` terminate only this worktree's owned tmux session and routes. Restart waits for fixed backend ports to become bindable; a remaining listener is reported by PID/command as non-owned and aborts startup. Port discovery never authorizes signaling a process, and discovery failure is a hard refusal.
- Before launching portless, dev start prunes stale Tailscale serve/funnel routes whose `127.0.0.1:<port>` target has no live listener. Cleanup is surgical per HTTPS port (`off`) only: never `tailscale serve reset`, and never prune a route with any live target.
- Tailscale serve is the default (`--tailscale`); `--no-tailscale` opts out to local-only; funnel is explicit opt-in (`--funnel` / `PORTLESS_FUNNEL=1`).
- Smoke/e2e should use portless/TLS routes unless intentionally in-process.

## Tailscale lifecycle contract

`lib/tailscale-lifecycle.ts` owns all Tailscale serve/funnel state management during dev startup and teardown:

- **Prune stale routes on start.** `pruneStaleRoutes` reads `serve status --json` + `funnel status --json`, probes every localhost target for liveness, and calls `off` on routes whose targets are all dead. Never touches a route with any live listener.
- **Surgical per-port cleanup only.** `cleanupExternalRoutes` disables known external routes or falls back to the expected set derived from `SharedDevServicePorts`. Never calls `tailscale serve reset`.
- **Verified before printed.** `ensureExternalRoutes` registers routes only if `verifyTailscaleExternalRoutes` fails; then re-verifies. Startup fails visibly if verification still fails.
- **`tailscaleRouteOffArgs`** in `lib/tailscale-stale-routes.ts` is the single call site that produces `off` arguments — no other module touches Tailscale route state.

## Worktree cleanup contract

`pnpm dev:prune-worktrees` safely tears down merged worktree resources:

- **Two modes:** `--auto` (all merged non-primary worktrees) or `--target <value>` (work id, worktree path, branch name, or PR number via `gh`).
- **Resolver** (`lib/worktree-cleanup.ts`) correlates work item ↔ task dir/worktree ↔ branch ↔ PR head branch. Ambiguous matches (multiple worktrees for a target, multiple work items for a worktree) refuse to resolve with candidate lists.
- **Commit-bound eligibility.** The base branch is detected from `origin/HEAD` (fallback `main`), not hardcoded. Planning resolves the local branch ref OID. Explicit `--target` cleanup requires that exact OID to be either an ancestor of the base or the unique head OID of a merged PR matching the base, branch, and repository owner. Historical same-name PRs, ambiguous matches, GitHub discovery failures, and moved refs are safe refusals. The OID (and ancestry evidence when used) is revalidated immediately before every action.
- **Auto readiness is separate.** `--auto` accepts exact merged-PR evidence only—ancestry alone is not stale evidence—and skips dirty worktrees, active Meridian work items, live tmux dev sessions, and processes whose cwd is inside the worktree. These gates run during planning and again immediately before that target's first teardown action.
- **Cleanup order per target:** stop dev stack → drop DB → remove git worktree → mark Meridian work done → atomically delete the local ref with `git update-ref -d <ref> <plannedOid>`.
- **Safety gates:** refuses primary worktree, current worktree, the base branch, branches that lack mode-appropriate commit evidence, detached worktrees, and auto targets with ownership or liveness evidence.
- **Confirmation:** dry-run prints every planned action and target; destructive cleanup requires interactive `[y/N]` or `--yes`.
- **`--dry-run`** prints the plan without executing it.

## WS 426 noise suppression (server-side)

Plain HTTP hits to WebSocket routes (`/api/threads/ws`, `/ws/yjs`) produce 426 Upgrade Required responses. The server observability layer (`apps/server/server/lib/request-observability.ts`, `routeStatusEvent`) suppresses these from the event log — they are expected for non-upgrade requests and never indicate a broken WebSocket:

- `isExpectedWsPlainHttpStatus` returns `true` when `statusCode === 426` and the route is `/api/threads/ws` or `/ws/yjs`.
- `routeStatusEvent` returns `null` for expected WS status codes (and all sub-400 statuses).

## Migration tooling

`migration-lint.ts` scans generated Drizzle SQL for risky production patterns
(renames, drops, unsafe `SET NOT NULL`, foreign keys without `NOT VALID`, indexes
without `CONCURRENTLY`, table-wide deletes/updates). A line can opt out with
`-- migration-lint: skip <RULE_ID>` when the migration is intentionally safe.

Supported modes:

| Mode | Use |
|---|---|
| `--all` | Lint every `packages/database/src/migrations/*.sql` file. Used by `pnpm db:migration-lint`. |
| `--staged` | Lint staged migration SQL only. Used by pre-commit. |
| `--changed <ref>` | Lint migration SQL added/modified/renamed since `<ref>...HEAD`. Used by PR CI. |
| `--strict` | Promote warnings to blocking failures. |

Policy:

- Errors always exit non-zero.
- Warnings exit non-zero only with `--strict`.
- The squashed `0000_` baseline is warning-exempt; `DELETE_WITHOUT_WHERE` remains
  an error there too.
- CI `migration-checks` always runs `drizzle-kit check` as a blocking journal /
  snapshot-chain check. PRs then run `migration-lint --changed origin/$BASE`;
  `--strict` is added only when the PR targets `main` or `staging`.
- Pre-commit runs `migration-lint --staged` when migration SQL is staged. It
  blocks errors, not warnings.

## Conventions

- Top-level scripts stay thin; reusable logic in `lib/`.
- `tools/dev/tsconfig.json` is the canonical strict type boundary.
  `tools/dev/project.json` registers `meridian-dev-tools:typecheck` as
  `tsc --noEmit -p tsconfig.json`; Nx discovers it for the root
  `pnpm typecheck` / `pnpm check` gate.
- URL transforms use `new URL()` — no regex surgery on connection strings.
- Explicit errors over silent fallback.
- Provider assumptions stay in dev tooling, not domain code.
- No file crosses 1,000 lines; `dev-tmux.ts` owns orchestration only, with session planning, readiness, port lifecycle, Tailscale lifecycle, and output policy extracted behind clear interfaces.

## Related documentation

- [`DEVELOPMENT.md`](../../../DEVELOPMENT.md) — env, worktrees, hooks, command reference
- [`packages/database/README.md`](../../../packages/database/README.md)
- [`tests/smoke/README.md`](../../../tests/smoke/README.md)
