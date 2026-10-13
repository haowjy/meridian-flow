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
    `transport.ts`, `stream.ts`, `events-map.ts`, `reduced-thread.ts`, `transcript.ts`,
    `resolve.ts`;
    project: `resolve.ts`; doc: `uri.ts`; mock: `queue.ts`). Groups may import
    another group's helper module (`thread/send` uses `mock/queue`, `doc/uri`),
    never `main.ts`; `core/` imports no group.
  - **Adding a group:** create `src/commands/<group>/` with its commands and an
    `index.ts` exporting a `CommandGroup`, then list it in `GROUPS` in
    `src/main.ts`. Help, parsing, output, and errors come from `core/`.
  - **Views derive from the shared reducer.** `reduced-thread.ts` hydrates a snapshot
    into `@meridian/thread-client`'s `InMemoryTurnStore` and applies each sequenced
    event through the same `createTurnReducer` the app uses. `thread view` renders
    its turns (`transcript.ts` and `block-timing.ts` are renderers over `Turn[]`).
    `send` and `tail --until-idle` follow with a hydrated store and compare each
    followed turn's reduced status and final text with the confirming snapshot's;
    the result carries `liveView: "matches" | "differs"` (and a compact `liveDiff`
    when it differs), absent when nothing was followed. A difference never changes
    the claim or exit code, since the claim is about the server; it means the app's
    live view would have shown something other than what the server stored. The
    claims themselves (`status`, `finalText`, outcome) still come from the
    confirming snapshot.
  - **The event log is a log.** `events-map.ts` (`RunEventMapper`) folds events into
    the dotted lines `thread events`, `send` and `tail` print, including both
    `tool.completed` and `tool.settled`. It decides when a command looks (stop
    triggers) and what to print, never what a turn contains.
  - **Output contract:** compact text by default; `--json` prints exactly one
    object, or NDJSON for streams. Live claims and journal replay end with one
    `type: "result"` envelope (`command`, `threadId`, `outcome`, `reason`, then
    command fields). Seed embeds its sends' envelopes and exits with their worst
    exit. `--fields` always preserves terminal `type`, `command`, `outcome` and
    `reason`. Proven outcomes have null reason; unproven is exit 6 with a reason. `accepted` (exit 0)
    is admission only: just `thread send --no-wait` returns it, never a waiting send.
    `terminalResult` is the single constructor: it returns the typed envelope
    and its mapped exit; proven outcomes require null reason, unproven and timeout
    require a reason. Reasons are `owed`, `running`, `lease_awake`,
    `admission_unknown`, `replay_truncated`, `unconfirmed`,
    `deliverer_unknown`, and `snapshot_disagrees`. Cancel also uses it for its acknowledgement (retaining
    not-found exit 3).
    Run failures are results; CLI errors remain on stderr. `EXIT` in `src/core/cli-error.ts` is the exit-code contract. Set
    `process.exitCode`; never call `process.exit()` (it truncates piped output).
  - **Missing data** means a new server route behind the debug gate
    (`resolveDebugPathsEnabled`, `APP_DEBUG=1`, never production), which
    `pnpm dev` opens by default.
  - Document commands parse the final path segment with the contracts name codec;
    `doc put` reports the canonical URI returned by creation.
    `doc put --overwrite` deletes the existing document and creates a new one
    (new id; its drafts and history are gone) and reports `previousDocumentId`;
    if the create then fails, the error says the old document was already deleted. Seed scenario names
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
deduplication, gaps and reconnect/resume, with the package's default socket
deadlines. A CLI subscription queue bounds waits by the command deadline; never
add CLI socket timers or tune the package's deadlines to a command's
`--timeout` (see the
[package's deadline contract](../../../packages/thread-client/.context/CONTEXT.md)).
Terminal/auth closes remain exit 4. `stream.ts` only
maps events, prints them and runs the existing CLI follow predicates. Those
predicates are not yet the shared follow session, so send still cannot prove which
reply answered its message. `tail --until-idle` reads an initial snapshot and
returns at once if idle. After a turn finish/failure, journaled lease/pending update or idle subscription state it
confirms a snapshot: null `liveState.runningTurnId`, `status.kind: "asleep"`
(no awake lease), and no writer-provenance message in `liveState.pending.items`.
One command-scoped subscription and event mapper remain alive through every
confirmation. Checkpoints drain queued events, await the snapshot, then consume
frames received during the request before confirming again. The result's
`turns` lists the initially running turn and every stream-named turn, with
snapshot statuses. Any observed failure or covered turn error is failed; otherwise
any cancellation is cancelled, missing/non-terminal turns are 6 `unconfirmed`,
and all complete is complete. A replay gap without a proven failure or cancellation
is 6 `replay_truncated`, preserving the idle evidence and covered turns.
Already idle with no wait has an empty list. Snapshot requests are capped at the
remaining deadline. A tail timeout uses the last snapshot with
`snapshotStale: true`, or `snapshotUnavailable: true` if none succeeded,
rather than extending the deadline for another HTTP request. This remains exit
124, never proof of idle, even if the last snapshot looks idle.
On a deadline, send reads a final snapshot; until-idle tail reports its last
bounded snapshot as described above. With a snapshot, results report `stillRunning`,
pending writer messages (`owed`), and `next`; they never cancel. Without a
snapshot, the deadline report contains only `reason: "unconfirmed"` and `next`;
the tail envelope adds `snapshotUnavailable: true`. Absent `stillRunning` and
`owed` mean unknown, not no running turn or no owed messages. Both use `classifyDeadline`
in `result.ts`, in precedence order: `running` for a running turn,
`owed` for pending writer messages, `lease_awake` for an awake lease with
neither, then `unconfirmed` (including no snapshot or an idle-looking snapshot
without confirmed completion). `lease_awake` is what a timeout reports when
the server still holds a run lease after its turn ended, for example after a
restart orphans a reply: orphan repair on this checkout leaves the lease row
and publishes no change to asleep
([#799](https://github.com/haowjy/meridian-flow/issues/799)). Expiry clears it
only at read time; the next command is an until-idle tail to check again, not
a writer action that clears the lease. Don't poll until expiry to hide this. The pending projection is
mandatory. Before reporting complete, send checks that the admitted user turn id
is absent from `liveState.pending.items` (writer admission uses that same id for
the inbox row). If it remains, send returns 6 `unproven` / `owed` with
`stillRunning` and a next until-idle tail, not the earlier run's answer.
This guard does not prove which reply answered; phase 2 still owns that binding.
`respond` uses the shared interrupt sender and confirms its exact interrupt's
journaled resolution (deadline: 6 `unconfirmed`). A replay gap makes `events`
6 `replay_truncated` after printing the replay. Send recovers a lost HTTP
admission answer with one app-route lookup (`submissionId`); a failed lookup
or pending admission is 6 `admission_unknown`. Tool results distinguish staged
`tool.completed` from committed `tool.settled` in both output modes.

Message admission calls `buildMessageDoc` for one paragraph containing inline
skills, prose and references, with authored newlines represented by `hardBreak`
(as in the composer), then passes it to `serializeMessageDoc`. Reference labels and image
capability come from the address route's catalog entry. This exercises the app's
serializer, not the TipTap editor or its submission lifecycle.

The strict tsconfig includes `src/`; TypeScript resolves the imported Portless
helpers without including the whole `tools/dev` tree. Cached Nx `typecheck` and
`test` targets include those shared helper files and the root shim as inputs.

The root Vitest project list includes this package's config exactly once.
`pnpm test` runs all CLI tests, including `src/main.test.ts`, which boots the
real root shim. The package's Nx test target is available for focused runs;
the root test gate does not also invoke that target.
