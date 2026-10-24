# tools/dev — development contracts

Safety boundaries for local databases, dev sessions, cleanup and migrations
that span more than one script.

## Environment and database

`DEV_DATABASES` is the single registry. Main `.env` values are loaded through
the shared environment helpers, and linked worktrees rewrite registered URLs to
an idempotent worktree database. Non-interactive shells need the same
`applyDevEnvToProcess` path as `.envrc`; failure to derive a scoped database is
loud, never a fallback.

`db:migrate` and `db:apply-functions` resolve the checkout the same way and
refuse a registered main database unless a human passes `--allow-main-database`;
their managed-test bypass accepts only a local disposable database whose owner
PID is a live, distinct ancestor of the command. Any other direct admin or test
command resolves the checkout the same way before touching a database.

`drop-db` protects every reserved main-checkout database; new main-like names
extend `RESERVED_DATABASES`, not the CLI. `db:reset` is the
schema-only reset for an owned active database; a full infrastructure wipe is a
separate explicit operation. `db:migrate` runs the locked migration runner and
function synchronization. Ordered code companions are declared and digest-pinned in
no-transaction SQL files; history validation refuses changed bytes. The runner invokes
`migrate(session)` before the SQL assertions and ledger write on its reserved advisory-
lock session. Domain-specific conversion stays beside its migration, not in tools/dev.

Managed DB tests provision owned databases and route each worker to its own
clone. Cleanup hands only this invocation's databases to the detached cleanup
child, verifies owner liveness, and leaves failures for GC. Shared or deployed
Postgres remains serial. Fixtures isolate state with rollback or the catalog-
derived FK delete policy, not per-case truncation. Only managed worker URLs get
`synchronous_commit=off` (a session startup setting); never change shared server
settings or dev database durability. Do not scale workers with CPU count against
the shared connection limit, and do not run `pnpm check` and `pnpm test:db` at
once in one worktree. `pnpm test:all` runs unit and DB projects together; its DB
reporter rejects a run with no passed or failed DB test, so a unit-only result
is not combined-run evidence.

The DB Vitest config refuses to run unless `RUN_DB_TESTS=1` and a throwaway
`DATABASE_URL` are set. A managed run migrates a template database from empty
and clones one database per worker from it. Managed names carry the owner's PID
for GC, and `test-run-`, `test-manual-` and `migrations_` are reserved
worktree-slug prefixes, so a worktree database can't pass for a managed one.

`pnpm check` ends with `check-db-gate.ts`: it skips loudly only when the
configured Postgres server is absent or unreachable (the static CI job has no
database service), and otherwise runs the full managed `pnpm test:db` suite and
propagates failures. `pnpm test:db` always forces the gate.

## Session and readiness

`applyDevEnvToProcess(repoRoot)` precedes `createDevSessionCommand`. The
executable command may contain secrets and is sent only to tmux; display output
and `.meridian/dev-session.json` contain the redacted command. The internal SSR
API origin is the paired worktree server origin, not the public app URL.
The production-client profiling mode uses the same session plan and Portless
routes. Its app command builds the client, runs the built Nitro server with
local dev auth enabled, and fronts it with the app-owned route inventory so
server-owned HTTP and WebSocket paths remain same-origin. Portless's
`NODE_EXTRA_CA_CERTS` is mandatory for the Nitro SSR fetch and the gateway's
HTTPS upstream. The persisted session identity records the client build, so
reuse refuses a development/production mismatch and `pnpm dev:restart`
preserves the running build as well as its transport mode. Session metadata
from before client-build identity existed reads as `development`; every new
launch writes the field.

`resolveCheckoutPortlessPrefix` owns hostname derivation for startup, `./mf`,
and browser tests. Only the primary checkout gets bare names. Linked detached
checkouts include their session slug and path hash, so equal commits cannot
alias each other. Commands use Portless named mode, not its branch inference;
session metadata retains the prefix used by a running stack across Git changes.
`dev-session-state.ts` validates the checkout-bound launch record and discovers
its live tmux session. Startup, `./mf`, and browser discovery use that active
identity, not current HEAD; Git derives only the next launch's identity. A
single resolved `DevSessionPlan` supplies commands, ports and verification
expectations. New/reused sessions share one readiness-and-publication pipeline.

Portless is the URL source of truth. `pnpm dev` reports `started` only after
expected routes, real HTTP readiness probes, and (when enabled) verified
Tailscale bindings pass. Startup failures identify the repository-relative
portless log. Tailscale cleanup probes target liveness and turns off individual
stale routes; it never calls a global reset or removes a live route. `--restart`
owns its configured ports: after tmux teardown it SIGTERMs every discovered
holder, waits briefly, then SIGKILLs stragglers, with discovery never gated on
tmux, cwd, or ancestry; a bound port it cannot inspect aborts startup loudly.
Fixed app backend ports sit in 20000-27999, below Linux's ephemeral range, so
an outgoing connection's source port can never hold one; a port busy with no
listener is reported as such.
`--force` requests restart semantics too. Both explicitly take over expected
Portless hostnames with warnings identifying the old PID, cwd when inspectable,
and backend port; ordinary startup refuses occupied names. Takeover uses
Portless's route-locked `--force` registration, not a global proxy reset.
Readiness requires positive route PIDs with cwd evidence inside this checkout,
and exact configured backend ports, before HTTP probes may pass.

`pnpm dev:stacks` reports each running stack's memory and idle time; it stops
nothing unless given `--reap-idle <minutes> --yes`, because a stack belongs to
the session that started it. Stopping a stack leaves its database and worktree
alone. The measurement behind it is in the header of `dev-stacks.ts`.

App boot smokes trust only a live spawned child and the exact shared route
contract. A foreign listener or generic non-5xx response is not evidence of a
successful boot.

## Cleanup and CLI

Worktree cleanup is target-first and commit-bound. It refuses the primary,
current, dirty, locked, detached, live, or insufficiently evidenced target;
revalidates ownership, liveness, and the planned ref OID before destructive
steps; and performs targeted stop, database removal, worktree removal, work-item
completion, and ref deletion in that order. Targeted eligibility is the planned
commit contained in another surviving ref (the branch's own local and
remote-tracking refs never count, resolved against the configured remote names:
a pushed branch is not merged) or one exact merged pull request, whichever base
branch it merged into. Containment proves preservation, not completion: the work
survives in the named ref, and the plan, the readiness gate, and the human
confirmation are what judge the lane finished. Containment is revalidated
against its ref before every action, symbolic refs never count as containers (an
alias can point at the deleted branch), and a remote-tracking candidate must
still exist upstream and still contain the commit when planning checks it (a
branch that moved is refreshed once), so a deleted or reset integration branch
cannot be cited. PR evidence rests on
GitHub's merge record rather than a local ref. Cleanup executes one run at a
time per repository: a second run refuses while one is executing, because two
runs' containment refs can be each other's branches, and a stale lock refuses
too rather than risking two owners; an interrupted run can leave a stale lock
that the refusal's message names for deletion. Batch cleanup needs explicit risk
acknowledgement and an exact merged PR into the base branch, and keeps refusing
duplicate exact records (ancestry alone is not enough).
Target-only `--force` permits managed dev-stack and Nx shutdown despite cwd
occupants, then rechecks that only known shell/tmux executables remain before
dropping the database and removing the checkout. It never signals those user
shells/panes and prints their PIDs and tmux pane IDs so owners can `cd` out of
the deleted directory. Unknown processes, unreadable attributed processes,
inspection failures, active work items and dirty state still block. Force does
not bypass merge evidence, branch/HEAD revalidation or structural protections,
and is rejected with `--auto`. Git worktree removal itself never uses `--force`.
Never infer staleness from a branch name, and add no cleanup
script that bypasses the shared resolver in `lib/worktree-cleanup.ts`; batch
staleness needs an exact merged PR, while targeted cleanup's containment is
confirmed by the human at the prompt. Prune a side-lane
branch when it merges into its integration branch: containment, or the lane's
own merged PR, proves it then, and either proof survives only while the
integration ref or the PR record does. Once the integration branch is
squash-merged and its ref deleted, a lane with no PR of its own has no automatic
proof left, and
[`WORKTREE-CLEANUP.md`](../WORKTREE-CLEANUP.md) reconstructs evidence for the
targeted `--manually-verified <reason>` path. That path replaces only automatic
eligibility discovery; every structural, readiness, and commit-movement guard
still applies.

The `./mf` CLI is [`tools/mf`](../../mf/.context/CONTEXT.md). It reads this
directory's Portless route contract (see [`AGENTS.md`](../AGENTS.md)).

## Migration and observability helpers

Migration identity is the journal entry plus SQL hash. History checks reject
removed, edited, renumbered, retimestamped, non-contiguous, or out-of-order
entries. Ordinary files commit each file with history; marked no-transaction
files autocommit breakpoint chunks and record history last. Lint rules are
centralized and a skip must be safe on populated tables.

Gate policy: lint errors always block and warnings block only under `--strict`
(CI PRs targeting `main` or `staging`); `--changed <ref>` scopes PR lint,
`--staged` powers pre-commit (errors only), and the `0000_` baseline is
warning-exempt except `DELETE_WITHOUT_WHERE`. CI always runs `drizzle-kit check`.
`check-migration-history.ts` compares the head against the base ref's journal
and SQL without a checkout; CI runs it on PRs into `main`/`staging` and on
pushes to `main` and `staging`, and only a manual `workflow_dispatch` skips it.
A column retirement needs a transactional `SET LOCAL lock_timeout` of 1 to 5
seconds before the drop (it bounds lock acquisition, not hold time), with reads
removed and data moved in the same change.

Plain HTTP requests to `/api/threads/ws` and `/ws/yjs` produce expected 426
responses and are suppressed by server observability. Add new WebSocket routes
to the same expected-status policy.
