# tools/mf — Dev CLI

`@meridian/mf` is a private workspace package, invoked by the repo-root `./mf`
shim with the root's `tsx`. Read [AGENTS.md](../AGENTS.md) before editing.

## Architecture and contracts

`./mf` drives the shared client core (`@meridian/thread-client`) against the
app's own HTTP routes and thread WebSocket, and calls the routes directly where no
core exists yet. It never reads Postgres and holds no business logic. Missing data
means a new server route behind the debug gate (`resolveDebugPathsEnabled`,
`APP_DEBUG=1`, never production), which `pnpm dev` opens by default.

- **Layout.** `src/core/` is the domain-free framework (`CommandSpec`/`CommandGroup`
  parsing, `output.ts`, the `EXIT` contract in `cli-error.ts`, `session.ts` for
  Portless discovery, the in-memory dev-login cookie and bounded requests) and
  imports no group. `src/commands/<group>/` holds one group each; a new group is
  listed in `GROUPS` in `src/main.ts`. A group may import another group's helper,
  never `main.ts`. Tests share `src/test-support/fake-stack.ts` (fake API and
  thread socket on the real contracts); `src/main.test.ts` boots the real shim.
- **Imports.** Workspace libraries are `@meridian/contracts` and
  `@meridian/thread-client` only. Portless discovery uses the route contract
  `pnpm dev` registers (`../dev/portless-prefix.ts`, `portless-routes.ts`,
  `portlessCa` in `dev-readiness.ts`, and `resolveCheckoutRouteUrls` in
  `dev-session-state.ts`, which finds an active session's routes by its recorded
  identity rather than the current branch). Duplicating that discovery here would
  drift from `pnpm dev`, so the allowed list was widened deliberately; its
  transitive `tools/dev` imports are Node-only. Never import `apps/`.
- **Views derive from the shared reducer.** `reduced-thread.ts` hydrates a
  snapshot into `InMemoryTurnStore` and applies each sequenced event through the
  app's `createTurnReducer`, with the stream seq (`ReducedThread.apply(event, seq)`).
  `thread view` runs `viewTranscript` over the hydrated turns and the record's
  waiting writer messages and only prints the rows; `chat-view.ts` decides no row
  and words no visible text. Text mode summarizes (a card's kind only, tool names,
  one `delivery:` line per group) and omits tool inputs and results, card props,
  Work receipts and occurrences; `--json` is the versioned `chatView: 2` envelope
  whose `inputs` states what the view was computed from (no local records,
  stand-ins, opening seed or live activity, inherited history omitted, background
  report bodies and change trails not fetched). `--full --json` is the inspectable
  form. A reply's `finalText` reads the same view model's visible text items.
- **`liveView` is a lead, not proof.** `send` and `tail --until-idle` compare each
  followed turn's reduced `status` and `finalText` with the confirming snapshot's:
  `matches`, `differs` (with a compact `liveDiff`) or `not_observed` (a replay gap,
  or a turn not seen from its start). It leaves out tools, reasoning, interrupts,
  the optimistic UI, the visible-turn policy, dividers, queued rows and row
  placement, so `matches` does not prove the screen was right, and it never
  changes the claim or exit code. The claims themselves come from the confirming
  snapshot. The planned rule
  ([claims are proofs](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md))
  is that a live disagreement will fail with exit 6 once the chat session's sync
  is shared; that is not true yet.
- **Output contract.** Compact text by default; `--json` prints exactly one object,
  or NDJSON for streams; errors go to stderr. Live claims and journal replay end
  with one `type: "result"` envelope (`command`, `threadId`, `outcome`, `reason`,
  then command fields), built only by `terminalResult`, which maps outcome to exit:
  proven outcomes carry a null reason, unproven (exit 6) and timeout (124)
  require one. Reasons: `owed`, `running`, `lease_awake`, `admission_unknown`,
  `replay_truncated`, `unconfirmed`, `deliverer_unknown`, `snapshot_disagrees`.
  `accepted` (exit 0) is admission only, returned just by `send --no-wait`. Run
  failures are results; `--fields` always keeps `type`, `command`, `outcome` and
  `reason`. Set `process.exitCode`; never call `process.exit()`.
- **Documents.** Commands parse the final path segment with the contracts name
  codec; `doc put` reports the canonical URI creation returns. `doc put
  --overwrite` deletes and recreates (new id, drafts and history gone), reports
  `previousDocumentId`, and says the old document was already deleted if the
  create then fails. Seed scenario names use writer spelling.
- **Usage refusals** are current pending state, not terminal run events. Send
  reconciles a replayed refusal with the durable snapshot before exiting 1
  (`failed`, reason `credits_exhausted`); an already recovered reply wins.

## Following a run

`transport.ts` composes one `ThreadSocketClient` per command with the session's
cookie and Portless CA. The shared client owns connected gating, replay, dedupe,
gaps and reconnect with the package's default socket deadlines. A CLI queue bounds
waits by the command deadline; never add CLI socket timers or tune the package's
deadlines to `--timeout` (see the
[deadline contract](../../../packages/thread-client/.context/CONTEXT.md)). Terminal
and auth closes are exit 4. `stream.ts` maps events, prints them and runs the
follow predicates; `events-map.ts` (`RunEventMapper`) folds events into the dotted
lines `events`, `send` and `tail` print and decides when to look, never what a turn
contains.

- **Busy, owed and blocked** come from the run-state record
  (`liveState.runState`, `subscribed`, `meridian.run_state`) through the package's
  selectors (`isBusy`, `isOwed`, `usageBlockedMessages`, `writerMessages`), the same
  the app uses; `commands/thread/run-state.ts` only holds the view.
- **`send`** follows from the admission's `resumeAfterSeq` and builds its turn from
  its own events, reading no snapshot before its deadline. Before reporting
  complete it checks that its admitted user turn is no longer owed in a record at or
  past its admission (`runStateVersion`; none when the admission has none). If still
  owed it returns 6 `owed` with `stillRunning` and a next until-idle tail. This does
  not prove which reply answered: that binding waits for #768 phase 2. A lost HTTP
  admission answer is recovered with one app-route lookup (`submissionId`); a failed
  lookup or pending admission is 6 `admission_unknown`.
- **`tail --until-idle`** hydrates a snapshot, follows from its `resumeAfterSeq`
  (`nextSeq` is freshness only and never filters events) and returns at once if
  idle. After a finish, failure, lease or record change or idle state it confirms a
  snapshot: `isBusy` false and `status.kind: "asleep"`. One subscription and mapper
  stay alive through every confirmation. Any observed failure or covered turn error
  is failed; otherwise any cancellation is cancelled; missing or non-terminal turns
  are 6 `unconfirmed`; all complete is complete. A replay gap without a proven
  failure or cancellation is 6 `replay_truncated`.
- **Deadlines never prove idle.** A timeout is exit 124 with the last snapshot
  (`snapshotStale: true`, or `snapshotUnavailable: true` if none), never an
  extended deadline. With a snapshot the report carries `stillRunning`, `owed` and
  `next`; absent means unknown, not none. `classifyDeadline` (`result.ts`) picks the
  reason in order: `running`, `owed`, `lease_awake` (neither, but `status.kind` is
  still `awake`: the record and the status disagree, so idle is unconfirmed; check
  again with an until-idle tail, never poll to hide it), then `unconfirmed`.
- **Removals and dividers are fenced by seq**, as in the app. A
  `meridian.messages.handed_back` frame tombstones its turns at its seq, and a
  `meridian.write_mode.switched` divider installs after its anchor turn. When the
  anchor is a user turn the stream never carried, the store holds the divider out
  (`ReducedThread.awaitsAnchor()`) and `followThread` hydrates one snapshot within
  the remaining deadline, at most once per 250 ms, with `observed: false`. It never
  inserts the divider at the tail. Sharing the reducer without this recovery left
  `./mf` holding the divider forever.
- `respond` uses the shared interrupt sender and confirms its interrupt's
  journaled resolution (deadline: 6 `unconfirmed`). `events` on a replay gap is 6
  `replay_truncated` after printing. Tool results distinguish staged
  `tool.completed` from committed `tool.settled`.
- Message admission builds one paragraph with `buildMessageDoc` and
  `serializeMessageDoc` (reference labels and image capability from the address
  route's catalog entry). This exercises the app's serializer, not the TipTap
  editor or its submission lifecycle.

JSON fixtures live in `fixtures/`; TypeScript in `src/`. The root Vitest project
list includes this package's config once; `pnpm test` runs every CLI test, and the
package's Nx test target is for focused runs only. Cached Nx `typecheck` and `test`
include the shared Portless helpers and the root shim as inputs.
