# tools/mf — Dev CLI

`@meridian/mf` is a private workspace package, invoked by the repo-root `./mf`
shim with the root's `tsx`. Read [AGENTS.md](../AGENTS.md) before editing.

## Architecture and contracts

- **`./mf` dev CLI** — `src/` is the agent-facing CLI behind the repo-root `./mf`
  shim: a thin wrapper over the app's own HTTP routes and thread WebSocket. It
  never reads Postgres and holds no business logic; when the API cannot answer a
  question, add a server route behind the debug gate instead of a CLI-side query.
  - `src/core/` is the framework and knows no domain: `command.ts` (`CommandSpec`,
    `CommandGroup`, strict flat-arg parsing, option helpers), `output.ts` (text /
    `--json` / NDJSON), `cli-error.ts` (the exit-code contract), `session.ts`
    (Portless discovery, in-memory dev-login cookie, bounded requests).
  - `src/commands/<group>/` holds one command group each (`thread`, `doc`,
    `project`, `mock`, `log`, `seed`, `api`): one file per command, an `index.ts`
    exporting the `CommandGroup`, and the group's own helpers (thread:
    `transport.ts`, `stream.ts`, `events-map.ts`, `transcript.ts`, `resolve.ts`;
    project: `resolve.ts`; doc: `uri.ts`; mock: `queue.ts`). Groups may import
    another group's helper module (`thread/send` uses `mock/queue`, `doc/uri`),
    never `main.ts`; `core/` imports no group.
  - **Adding a group:** create `src/commands/<group>/` with its commands and an
    `index.ts` exporting a `CommandGroup`, then list it in `GROUPS` in
    `src/main.ts`. Help, parsing, output, and errors come from `core/`.
  - **Output contract:** compact text by default; `--json` prints exactly one
    object, or NDJSON for streams. Live claims and journal replay end with one
    `type: "result"` envelope (`command`, `threadId`, `outcome`, `reason`, then
    command fields). Seed embeds its sends' envelopes and exits with their worst
    exit. `--fields` always preserves terminal `type`, `command`, `outcome` and
    `reason`. Proven outcomes have null reason; unproven is exit 6 with a reason.
    Run failures are results; CLI errors remain on stderr. `EXIT` in `src/core/cli-error.ts` is the exit-code contract. Set
    `process.exitCode`; never call `process.exit()` (it truncates piped output).
  - **Missing data** means a new server route behind the debug gate
    (`resolveDebugPathsEnabled`, `APP_DEBUG=1`, never production), which
    `pnpm dev` opens by default.
  - Document commands parse the final path segment with the contracts name codec;
    `doc put` reports the canonical URI returned by creation. Seed scenario names
    use writer spelling, not slugs or prose suffixes.
  - **Imports:** workspace libraries are limited to `@meridian/contracts` and
    `@meridian/thread-client`. Portless discovery uses the same route contract
    as `pnpm dev`: `../dev/portless-prefix.ts`, `../dev/portless-routes.ts`,
    and `portlessCa` from `../dev/dev-readiness.ts`. Never import `apps/`.
  - Tests share `src/test-support/fake-stack.ts` (fake API + thread socket on the
    real contracts); `src/main.test.ts` also boots the real `./mf` shim.

## Package boundaries and verification

JSON fixtures live in `fixtures/`; TypeScript lives in `src/`.
The package declares its runtime dependencies (`@meridian/contracts`,
`@meridian/thread-client`, `ws`) and its TypeScript/test tooling.

`transport.ts` composes one `ThreadSocketClient` per command run with the session's
cookie and Portless CA. The shared client owns connected gating, replay,
deduplication, gaps and reconnect/resume. A CLI subscription queue bounds waits
by the command deadline; terminal/auth closes remain exit 4. `stream.ts` only
maps events, prints them and runs the existing CLI follow predicates. Those
predicates are not yet the shared follow session, so the existing run-outcome
limitations still apply. In particular `tail --until-idle` waits for the next
`turn.finished` or `turn.failed`, not confirmed idle. On a deadline, send and
until-idle tail read a final snapshot and report `stillRunning`, pending writer
messages (`owed`, or `pendingUnavailable`), and `next`; they never cancel.
`respond` uses the shared interrupt sender and confirms its exact interrupt's
journaled resolution (deadline: 6 `unconfirmed`). A replay gap makes `events`
6 `replay_truncated` after printing the replay. Send recovers a lost HTTP
admission answer with one app-route lookup (`submissionId`); a failed lookup
or pending admission is 6 `admission_unknown`. Tool results distinguish staged
`tool.completed` from committed `tool.settled` in both output modes.

Message admission builds skill nodes, a prose paragraph, then reference nodes
and passes that document to `serializeMessageDoc`. Reference labels and image
capability come from the address route's catalog entry. This exercises the app's
serializer, not the TipTap editor or its submission lifecycle.

The strict tsconfig includes `src/`; TypeScript resolves the imported Portless
helpers without including the whole `tools/dev` tree. Cached Nx `typecheck` and
`test` targets include those shared helper files and the root shim as inputs.

The root Vitest project list includes this package's config exactly once.
`pnpm test` runs all CLI tests, including `src/main.test.ts`, which boots the
real root shim. The package's Nx test target is available for focused runs;
the root test gate does not also invoke that target.
