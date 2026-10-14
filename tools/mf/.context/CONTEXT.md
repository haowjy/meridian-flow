# tools/mf — Dev CLI

`@meridian/mf` is a private workspace package, invoked by the repo-root `./mf`
shim with the root's `tsx`. Read [AGENTS.md](../AGENTS.md) before editing.

## Architecture and contracts

- **`./mf` dev CLI** — `src/` is the agent-facing CLI behind the repo-root `./mf`
  shim. It drives the shared client core (`@meridian/thread-client`) against the
  app's own HTTP routes and thread WebSocket, and calls the routes directly where
  no core exists yet. It never reads Postgres and holds no business logic of its
  own; when the API cannot answer a question, add a server route behind the
  debug gate instead of a CLI-side query.
  - `src/core/` is the framework and knows no domain: `command.ts` (`CommandSpec`,
    `CommandGroup`, strict flat-arg parsing, option helpers), `output.ts` (text /
    `--json` / NDJSON), `cli-error.ts` (the exit-code contract), `session.ts`
    (Portless discovery, in-memory dev-login cookie, bounded requests).
  - `src/commands/<group>/` holds one command group each (`thread`, `doc`,
    `project`, `mock`, `log`, `seed`, `api`): one file per command, an `index.ts`
    exporting the `CommandGroup`, and the group's own helpers (thread:
    `transport.ts`, `stream.ts`, `events-map.ts`, `reduced-thread.ts`, `chat-view.ts`,
    `reply-text.ts`, `resolve.ts`;
    project: `resolve.ts`; doc: `uri.ts`; mock: `queue.ts`). Groups may import
    another group's helper module (`thread/send` uses `mock/queue`, `doc/uri`),
    never `main.ts`; `core/` imports no group.
  - **Adding a group:** create `src/commands/<group>/` with its commands and an
    `index.ts` exporting a `CommandGroup`, then list it in `GROUPS` in
    `src/main.ts`. Help, parsing, output, and errors come from `core/`.
  - **Views derive from the shared reducer.** `reduced-thread.ts` hydrates a snapshot
    into `@meridian/thread-client`'s `InMemoryTurnStore` and applies each sequenced
    event through the same `createTurnReducer` the app uses. `thread view` runs the
    shared `viewTranscript` (`@meridian/thread-client`) over the hydrated turns and the
    snapshot record's waiting writer messages (`liveState.runState.items`), then prints its rows: text as `you:`, `reply: 3 steps,
    read 2 docs`, `compaction:`, `queued: N`, or `--json` as the versioned
    `chatView: 2` envelope (row identity, kind, items, and `inputs`, which states what
    the view was computed from: no local records, stand-ins, opening seed or live
    activity, inherited history omitted, and background report bodies and change trails not fetched). `--full --json` is the inspectable form: paired
    tools with input, result, streamed output, metadata and parsed Work receipt (plus the turn's `workReceipts`), raw card content and direct results, report
    payloads, the handoff brief, delivery bodies (a reply's delivery groups are its last
    item) and writer occurrences. Text mode summarizes (a card's kind only, since React words each card itself; fold tool names,
    one `delivery:` line per group, references set apart by a space) and omits tool
    inputs and results, card props, Work receipts, report payloads and occurrences. `chat-view.ts`
    only prints; it decides no row and words no visible text (reasoning and plain-row
    text come from the view model). `--blocks` times only the selected rows' turns,
    not hidden plumbing or delivery turns. `--turn`, `--last`
    and `--full` select rows; `--blocks` prints per-block timing
    (`block-timing.ts`). A reply's `finalText` (`send`) and the `liveView`
    comparison (`tail` prints no `finalText`; its text comparison changes only through
    `ReducedThread.compare`) read the same view model's visible text items in order
    (`reply-text.ts`).
    `send` and `tail --until-idle` follow with a hydrated store and compare each
    followed turn's reduced status and final text with the confirming snapshot's;
    the result carries `liveView: "matches" | "differs" | "not_observed"` (and a
    compact `liveDiff` when it differs), absent when nothing was followed.
    `not_observed` means the follow had a replay gap, or a compared turn's events
    were not seen from its start. `liveView` compares this CLI follower's reduced
    status and final text with the stored turn. It is not a certificate of any
    browser screen: it leaves out tools, reasoning, interrupts, the optimistic UI,
    the visible-turn policy, write-mode dividers, queued rows and row placement, and
    the app reconciles to the server at turn end. `ReducedThread.compare` checks
    exactly `status` and `finalText`; a missing divider can't make it `differs`.
    `differs` is a lead to investigate, `matches` does not prove the screen was
    right, and it never changes the claim or exit code. The planned rule
    ([claims are proofs](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md))
    is that once the chat session's sync is shared, a live disagreement will fail
    with exit 6; that is not true yet. The claims themselves (`status`,
    `finalText`, outcome) still come from the confirming snapshot. `send` reads no
    snapshot before its deadline: it follows from the admission's `resumeAfterSeq`
    and builds its turn from its own events. `tail --until-idle` hydrates a
    snapshot and follows from that snapshot's `resumeAfterSeq`; `nextSeq` is only
    snapshot freshness and never filters events.
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
  - Usage refusals are current pending state, not terminal run events. Send
    reconciles a replayed block with the durable snapshot before returning exit 1
    (`failed` with reason `credits_exhausted`); an already recovered reply wins
    over an obsolete refusal for that message.
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
maps events, prints them and runs the existing CLI follow predicates. Their run-state
reads go through the shared `@meridian/thread-client` module (`commands/thread/run-state.ts`):
`liveState.runState` and `meridian.run_state` frames. Send still cannot prove which reply
answered its message until B. `tail --until-idle` reads an initial snapshot and
returns at once if idle. After a turn finish/failure, journaled lease/pending update or idle subscription state it
confirms a snapshot: `isBusy` false for `liveState.runState` (no open execution, no
writer-provenance message in `items`) and `status.kind: "asleep"` (no awake lease).
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
without confirmed completion). `lease_awake` is a timeout whose snapshot shows neither a running turn nor an owed
message but still reports `status.kind: "awake"`: the record and the status disagree,
so idle is unconfirmed. It is not a claim about the record, and the next command is an
until-idle tail to check again. Don't poll to hide it.

The run-state record (`liveState.runState`, one whole record per snapshot, `subscribed`
state or `meridian.run_state` frame) is what `./mf` reads for busy, owed and
usage-blocked. The rules are the package's selectors over the view (`isBusy`,
`isOwed`, `usageBlockedMessages`, `isBlockedForUsage`, `writerMessages`), the same the
app uses; `run-state.ts` only holds the view. Before reporting complete, send checks
that its admitted user turn id is no longer owed: the record doesn't list it, and the
record read is at or past its admission (`runStateVersion`; none when the admission has
none, because its record is from after it). If it is still owed, send returns 6
`unproven` / `owed` with `stillRunning` and a next until-idle tail, not the earlier
run's answer. This guard does not prove which reply answered; that binding waits for B,
and `send`'s message proof waits for B too.

Events reach the shared turn reducer with their stream seq (`ReducedThread.apply(event,
seq)`), as in the app, so a removal (`meridian.messages.handed_back`) tombstones its
turns at the frame's seq and an older snapshot cannot bring a handed-back message
back. A `meridian.write_mode.switched` frame installs its divider after its anchor
turn the same way. When the anchor is a user turn the stream never carried (`send`
starts with an empty store; another client's message), the store holds the divider
out and `ReducedThread.awaitsAnchor()` says so. `followThread` (`stream.ts`) then
hydrates one snapshot within the remaining deadline, at most once per 250 ms, with
`observed: false` so the comparison stays honest. It never inserts the divider at
the tail. This is the app's recovery rule, shared through the store's
`dividersAwaitingAnchor`; sharing the reducer without it left `./mf` holding the
divider forever.

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
