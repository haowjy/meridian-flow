# tools/dev — development contracts

Safety boundaries for local databases, dev sessions, cleanup and migrations
that span more than one script.

## Environment and database

`DEV_DATABASES` is the single registry. Every dev entry point calls
`applyDevEnvToProcess` (rule in its docstring); no direnv or shell hook exports
repo values. The base database has one source, the main `.env`, so the
main-database guard, `gc-dbs`, `run-db-tests` and the loader cannot disagree
about which database is main. No build config runs the loader, and
`shared-db-server` loads server configs in-process and passes its own URL as
given (it uses only the fill step). The dev supervisor calls the same loader each
time it starts the services. `tools/dev/psql` hands `psql`
its connection as `PG*` variables, never argv. CI and deploy migrations reach the
loader through `db:migrate` with no file defining the URL. Failure to derive a
scoped database is loud, never a fallback.

A linked worktree's database is `<base>_<directory name>`, lowercased with other
characters turned into hyphens. It follows the directory, so the branch checked out
there doesn't matter and a running stack never points at a database its checkout no
longer names. Two worktrees whose directories share a name would share a database, so
the loader refuses to run in either.

Ports and the database name identify a worktree by two different rules, on purpose. A
port is chosen once and stored in the worktree's `.env.local`, where it can be edited,
because a port clash is loud: the second stack fails to bind. A database name is
derived on every run and never stored, because a database clash is silent: two
worktrees would write to the same data. A stored name copied from one worktree to
another would do exactly that, so don't make the database name a setting.

`db:migrate` resolves the checkout the same way, the main checkout's database
included: it installs the baseline into a database that has none, in one transaction,
or stops, so there is nothing to guard. A refusal there made `pnpm bootstrap` fail on a
fresh clone and left `pnpm db:reset` with an erased database it would not refill. Its
managed-test bypass accepts only a local disposable database whose owner
PID is a live, distinct ancestor of the command. Any other direct admin or test
command resolves the checkout the same way before touching a database.

`drop-db` protects every reserved main-checkout database; new main-like names
extend `RESERVED_DATABASES`, not the CLI. `db:reset` is the
schema-only reset for an owned active database; a full infrastructure wipe is a
separate explicit operation. `db:migrate` applies the generated baseline and its
ledger row in one locked transaction. Extensions, functions and triggers are
included in the baseline; there is no post-install sync or code companion.

Managed DB tests provision owned databases and route each worker to its own
clone. Cleanup hands only this invocation's databases to the detached cleanup
child, verifies owner liveness, and leaves failures for GC. Suite-owned
databases use the managed template's `-worker-` prefix and never drop inline on
managed runs: PostgreSQL makes each drop wait for an immediate checkpoint, so
the detached collector removes them after Vitest exits. Unmanaged runs have no
collector and drop their suite-owned databases inline. CI clones 3 worker
databases from the one its workflow migrated, on the runner's own loopback
Postgres (`isCiRunnerPostgres`), and leaves them to die with the runner. Any
other shared or deployed Postgres stays serial. Fixtures isolate state with rollback or the catalog-
derived FK delete policy, not per-case truncation. Only managed worker URLs get
`synchronous_commit=off` (a session startup setting); never change the shared
server's durability settings or dev database durability. Do not scale workers
with CPU count against the shared connection limit, and do not run `pnpm check`
and `pnpm test:db` at once in one worktree.

Concurrent managed runs from different checkouts share the dev server without a
cross-run queue. Drop each run's databases in detached cleanup: PostgreSQL waits
for an immediate checkpoint on drop, which can otherwise time out a test hook.
Local runs use four workers (`DB_TEST_WORKERS` overrides). Size concurrency for
host memory and the shared server's connection limit, not the host's CPU count.

`pnpm test:all` runs unit and DB projects together; its DB
reporter rejects a run with no passed or failed DB test, so a unit-only result
is not combined-run evidence.

Suites shuffle by default; seed replay is in
[`tools/ci/README.md`](../../ci/README.md). Server DB workers share their module
cache, so the server setup drains the runtime's detached-work tracker after
each case, after file-local teardown and before suite pool closers, with a
file-level drain as the next-file backstop. The shared `closeTestDatabase`
closer drains again before applying a bounded PostgreSQL pool timeout.

The DB Vitest config refuses to run unless `RUN_DB_TESTS=1` and a throwaway
`DATABASE_URL` are set. A managed run migrates a template database from empty
and clones one database per worker from it. Managed names carry the owner's PID
for GC, and `test-run-` and `test-manual-` are reserved
worktree-slug prefixes, so a worktree database can't pass for a managed one.

`pnpm check` ends with `check-db-gate.ts`: Vitest's module graph selects DB test
files related to changes since `origin/main`, including staged, unstaged and
untracked files. No related DB files skips; an absent or unreachable configured
Postgres server fails, so `pnpm check` cannot pass with related tests unrun. DB
config, migrations, shared DB test support and DB-test lifecycle or
dependency-resolution inputs bypass selection and run the full suite, as does
`DB_GATE_FULL=1`. The gate provisions the same owned test databases as `pnpm
test:db`; `pnpm test:db` and the manually dispatched CI `db-tests` job always run
every DB file.

## Stack and readiness

A checkout's ports are a block of ten, of which app, server and www take the first
three. The block's base has one source: `DEV_PORT_BASE` in the checkout's `.env.local`,
read by `resolveDevPorts` (`lib/dev-ports.ts`). When the line is missing, the main
checkout (whose `.git` is a directory) gets 20000, and a linked worktree is given a
block on the spot: `20010 + (sha256(path) % 799) * 10`, moved past any block within ten
ports of a base in another checkout's `.env.local`, and appended to the worktree's
`.env.local`. So no reader ever sees a guess that a later choice could contradict, and
the hash matters only for that first choice. Moving a stack is editing the number.
There is no shell override and no registry to go stale. A taken port fails the start
with the port named; the launcher never moves to a free one. The main checkout is never
written to: a tool that copies ignored files from it into a new worktree would copy the
base too.

Readers follow one rule. Code that talks to a stack reads its record, through
`runningStack` or `requireRunningStack` (`lib/dev-stack.ts`): `pnpm dev` for a stack
that is already up, `./mf`, Playwright and the QA probes. With no stack they fail
saying so, not with a refused connection. Only code that starts a stack or has to stay
clear of its ports calls `resolveDevPorts`: the launcher, the supervisor and
`tools/qa/shared-db-server.ts`. The app's Vite config reads `MERIDIAN_API_ORIGIN`,
which whoever starts the dev server sets, and refuses to serve without it.
`pnpm dev --stop` reads only the record, so a mistyped base can't keep a stack from
being stopped.

Browser URLs are `http://localhost:<port>`; processes reach each other on
`http://127.0.0.1:<port>`, where every service binds. There is no proxy, certificate
or per-worktree hostname.

`pnpm dev` (`dev.ts`) checks Postgres and the ports and starts `dev-supervisor.ts`
detached with the shell's environment, less the variables pnpm and Nx set for the
command itself. Nothing in `dev.ts` loads `.env` into that environment
(`assertDevInfraReady` fills a copy), or the values would outlive a restart that is
meant to read the file again. The supervisor loads `.env` through `applyDevEnvToProcess` each time it
starts the services, sets `PORT`, `MERIDIAN_API_ORIGIN`, `MERIDIAN_APP_ORIGIN` and, with
`--www`, `MERIDIAN_WWW_ORIGIN`, and writes `.meridian/dev-stack.json`. `pnpm dev`
reports `started` only after that record names the supervisor it launched and the
server's `/readyz` and the app both answer; if the supervisor exits first, it prints
the end of `logs/dev.log`.

The record holds the supervisor's pid and `ps` start time, the same pair for each
service it started, the client build, the ports, a generation number and the
last-active time, and no environment values. `pnpm dev` holds `.meridian/dev-start.lock`
while it starts a stack, so two starts cannot overwrite each other's record. A restart
bumps the generation, which is how `pnpm dev:restart` knows the new services are the
ones answering. The production-client mode runs the app's `profile:dev-stack` script in
place of `vite dev`; that script builds the client and fronts the built server with the
app-owned route inventory, so server-owned HTTP and WebSocket paths stay same-origin.

The browser reaches the server only through the app's port. The dev proxies (Vite's
`server.proxy`, `api-http-dev-proxy-plugin.ts`, the production-client gateway) forward
the `Host` header unchanged, because the dev sign-in rule in
`@meridian/contracts/dev-auth` accepts an `Origin` only when it equals the request's
`Host`. Rewriting `Host` to the server's port would sign every browser request out.
Trusting a name instead would be wrong: every dev stack is `localhost`, so any local
page could act as the dev user, and anyone can serve a page under `*.ts.net`.

`pnpm dev --tailscale` makes the supervisor publish the app port, and the www port with
`--www`, through `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` before it
starts the services (`lib/dev-tailscale.ts`). The tailnet URL is
`https://<machine>.<tailnet>.ts.net:<port>`, the same port number as on localhost: a
machine has one tailnet name and one certificate, so a stack can't have a name of its
own, and a path prefix would be stripped before the request reaches the app.
`tailscale serve` forwards the browser's `Host`, so the sign-in rule above holds there.
The record's `tailnetHost` is set while the routes exist, and the supervisor passes the
tailnet origins as `MERIDIAN_APP_ORIGIN` and `MERIDIAN_WWW_ORIGIN`, so the links between
the app and the marketing site work from the other device.

A route belongs to the stack only when it is the single `/` handler on that port,
proxies to the stack's own `127.0.0.1:<port>`, and is not a Funnel. Publishing checks
every port first and fails on any other route; stopping removes only the stack's own.

A route never exists without a record that names it. The supervisor writes the record
with `tailnetHost` before it publishes the first route. Teardown is one function,
`retireStack` (`lib/dev-stack.ts`): it removes the stack's routes, then the record, and
throws with the record kept when Tailscale doesn't answer. The supervisor calls it as
it stops. `stopStack` calls it for a record that is still there once the processes are
gone, which is a supervisor that was killed or could not reach Tailscale.
The next `pnpm dev` runs `stopStack` first, so it can't start a stack on a port that an
old route still publishes. One case is not covered: a removed checkout takes its record
with it, so if Tailscale fails at that moment the route stays until someone removes it
with `tailscale serve --https=<port> off`.

## Stopping and cleanup

`pnpm dev --stop` reads the record, takes the process trees of the supervisor and of
each recorded service, sends the supervisor `SIGTERM` and waits for it; whatever in
those trees is still alive after 15 s gets `SIGKILL`. The supervisor does the same to
its services with a 5 s grace. Both find processes by parentage from `ps`, since pnpm
puts each script in a process group of its own, and both check a pid's start time
again before each signal. A stop that arrives during a restart waits for the restart
to notice and start nothing, so no service is born after the tree is taken.

Nothing sweeps for orphans. A stack whose checkout is removed stops itself. A
supervisor killed outright (`SIGKILL`, the OOM killer) leaves its services running;
the record still names them, so `pnpm dev --stop` stops them and the next `pnpm dev`
stops them before it starts.

Removing a worktree is `wt remove`. Its `post-remove` hook runs `pnpm dev:gc-dbs`, which
drops every project database that no live worktree, connection, running test or manual
label claims.

## Migration and observability helpers

The baseline runner holds a session advisory lock and commits its SQL with the
ledger row in one transaction. An installed hash mismatch requires an explicit
local reset; no deployed database is reset automatically. Dev preflight uses the
same check. `generate-baseline.ts` rebuilds from schema, function and custom SQL
inputs; CI checks regeneration produces no diff and applies it from empty.
See [database rules](../../../packages/database/AGENTS.md).

Plain HTTP requests to `/api/threads/ws` and `/ws/loro` produce expected 426
responses and are suppressed by server observability. Add new WebSocket routes
to the same expected-status policy.
