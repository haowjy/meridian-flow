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
  never `main.ts`. Command tests run the real CLI against `src/test-support/wire.ts`,
  a thin HTTP and WebSocket harness. It is not a simulator and follows no server
  rules: each test states the contract facts it needs (admission answer, the
  snapshot each read returns, Stop's answer, ordered journal frames and when they
  go out), typed with `@meridian/contracts` through `wire-fixtures.ts`. The harness
  records what `./mf` posted and can fail a transport (drop a connection, answer
  with a body that is not JSON, delay a read, close the socket). A command test
  checks that request and how the answer was read. Stop's scope, adoption and
  settlement are proven by the server's protocol tests and real-stack probes, not
  here.
- **What `./mf`'s tests cover.** Shared rules are tested once, in their package. `./mf`'s
  tests cover CLI admission assembly, exit codes, replay safety, the deadline and never claiming
  more than it proved; everything else is a live probe or recipe
  ([decision](https://github.com/haowjy/meridian-flow-docs/blob/f3da199a87/kb/decisions/engineering/dev-cli/mf-tests-script-the-wire.md)).
- **Imports.** Workspace libraries are `@meridian/contracts` and
  `@meridian/thread-client` only. Portless discovery uses the route contract
  `pnpm dev` registers (`../dev/portless-prefix.ts`, `portless-routes.ts`,
  `portlessCa` in `dev-readiness.ts`, and `resolveCheckoutRouteUrls` in
  `dev-session-state.ts`, which finds an active session's routes by its recorded
  identity rather than the current branch). Duplicating that discovery here would
  drift from `pnpm dev`, so the allowed list was widened deliberately; its
  transitive `tools/dev` imports are Node-only. Never import `apps/`.
- **Success claims require validated evidence.** Every domain-success claim printed by
  `./mf` comes from a contracts-validated response or shared-client protocol evidence.
  `Session.request` requires one decoder: contracts JSON, raw text, or intentionally
  unknown JSON. Structured requests reject empty,
  non-JSON and schema-invalid answers as classified read errors. Send admission and
  recovery, creation, cancellation, document reads/writes and mock commands pass contracts
  schemas. Stop and queue pass unknown bodies to the shared hand-back operation, which
  validates them before confirming. Snapshots use `threadSnapshotSchema` in both hosts.
  Work and document-reference lookups use explicitly typed identity projections, not casts
  claiming full catalog validation. Deletion must also include the requested document in
  `removed` with its removal identity before `doc rm` or overwrite reports it deleted.
  Diagnostic-only assertions remain in `project/list.ts`, `log/log.ts` and
  `thread/context.ts`; none feeds a mutation or terminal claim.
  Generic `api` explicitly requests text, then decodes JSON/transport envelopes when possible;
  empty responses print null. It prints arbitrary server data, not validated domain outcomes,
  and exit 0 means only HTTP 2xx. Parser exceptions and exceptions inside sync remain
  programming errors, not read failures.
- **Views derive from the shared projections.** `thread view` runs `chatCards` and
  `viewTranscript` over one contracts-validated snapshot read (`chatSnapshot(snapshot,
  snapshot.turns)`: no socket, no `ThreadSync`, no store). It prints rows and the cards
  durable facts give, with their copy keys, anchors and actions. Local command failures
  (a lost Retry, a failed Stop, an unadmitted send) are not in that snapshot and cannot
  appear here. `chat-view.ts` decides no row or card and words no visible text. Text mode summarizes (a card's kind only, tool names,
  one `delivery:` line per group) and omits tool inputs and results, card props,
  Work receipts and occurrences; `--json` is the versioned `chatView: 2` envelope
  whose `inputs` states what the view was computed from (no local records,
  stand-ins, opening seed or live activity, inherited history omitted, background
  report bodies and change trails not fetched). `--full --json` is the inspectable
  form. Outside `cards`, raw `row.error`, failure reasons and provider errors are
  diagnostics, not the app's failure text or evidence of which failure the writer sees.
  A reply's `finalText` reads the same view model's visible text items.
- **`send` and `tail --until-idle` follow through the app's thread sync.**
  `observe.ts` composes one `createThreadSync` (`@meridian/thread-client/sync`) with Node
  ports: the chat's `SyncedThread` in a variable, one HTTP read at a time (`"fresh"` while one is
  in flight queues one more after it; each read's timeout is the remaining command deadline and
  `stop` aborts the one in flight), `SNAPSHOT_RETRY_MS` after a `stale` read, and the command's
  abort signal. The sync, not `./mf`, decides when to read, how the first applied read joins
  replay (a generation reduces no frame before it has applied a read, and subscribes at the
  later of that read's `resumeAfterSeq` and the cell's delivery cursor, so `./mf` never replays
  from 0), what counts as missing (held dividers and waiting writer messages recover through
  reads, not CLI code), and the order frames reach the turns. `observe.ts` keeps no queue of
  frames before the first read: it delivers none. Each frame is filtered before printing and
  claim bookkeeping: it counts only if above the claim's cursor (`send`: the admission's
  `resumeAfterSeq`; `tail`: the first applied read's) and above every seq already counted. A gap
  counts against the claim when its range reaches past the cursor or is unknown.
  `thread events`, plain `thread tail` and `thread answer` read the journal over the shared
  transport and hold no transcript client state. Plain tail and the printer claim nothing from
  content; `thread answer` runs the shared durable-ask command and prints its resolution.
  `thread stop` and `thread queue` read one snapshot and run the hand-back operation.
- **`liveView` is the sync's end-of-turn check, a diagnostic.** When the stream's own frames
  end an assistant turn (complete, cancelled, error), the next applied read is compared with it:
  status and the turn's own text, exactly. `matches`; `differs` (with a compact `liveDiff` naming
  each `turnId`); or `not_observed` with `liveReason`: `no_turn` (the claim names no assistant
  turn), `rewritten` (a read seeded text, including at join, changed the turn while the stream was
  writing it, or ended it first and replay ended it again), `read_ended` (a read showed it terminal before the stream wrote
  it), `not_ended` (the stream did not end it within the catch-up), or `gap`. A difference is
  kept even if a later read agrees. It sees client state, not paint: no tools, reasoning,
  ask receipts, rows, dividers or queued rows, so `matches` does not prove the screen was right,
  and it never changes the claim or exit code. Only the proving read decides those. The planned
  rule ([claims are proofs](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md))
  is that a true disagreement will fail with exit 6 once every `differs` has been classified;
  that is not true yet.
- **Output contract.** Compact text by default; `--json` prints exactly one object,
  or NDJSON for streams; errors go to stderr. Live claims and journal replay end
  with one `type: "result"` envelope (`command`, `threadId`, `outcome`, `reason`,
  then command fields), built only by `terminalResult`, which maps outcome to exit:
  proven outcomes carry a null reason, unproven (exit 6) and timeout (124)
  require one. Reasons: `owed`, `running`, `lease_awake`, `admission_unknown`,
  `replay_truncated`, `unconfirmed`, `deliverer_unknown`; a `failed` outcome may carry
  `credits_exhausted`, `not_a_message` or `forgotten`. Outcomes: `accepted`,
  `complete`, `failed`, `cancelled`, `handed_back` (exit 5, shared with cancelled),
  `timeout`, `unproven`.
  Exit codes (`EXIT` in `src/core/cli-error.ts`): 0 proven; 1 the app failed or the
  server refused; 2 usage; 3 not found; 4 unavailable (the stack, login, a closed socket,
  or a Stop, hand-back or Send now answer that could not be read); 5 cancelled or handed
  back; 6 unproven; 124 `./mf`'s own deadline.
  A message the chat forgot (`forgottenBy`, after the chat moved past its failed reply)
  makes `send` exit 1 with `failed`/`forgotten` before any reply is attributed to it.
  `accepted` (exit 0) is admission only, returned just by `send --no-wait`. Run
  failures are results; `--fields` always keeps `type`, `command`, `outcome` and
  `reason`. Set `process.exitCode`; never call `process.exit()`.
- **Documents.** Commands parse the final path segment with the contracts name
  codec; `doc put` reports the canonical URI creation returns. `doc put
  --overwrite` deletes and recreates (new id, drafts and history gone), reports
  `previousDocumentId`, and says the old document was already deleted if the
  create then fails. Seed scenario names use writer spelling.
- **Usage refusals** are current pending state, not terminal run events. Send
  exits 1 (`failed`, reason `credits_exhausted`) only when its confirming snapshot's
  `messageFate` is waiting and blocked; an already recovered reply wins.

## Following a run

`transport.ts` composes one `ThreadSocketClient` per command with the session's
cookie and Portless CA. The shared client owns connected gating, replay, dedupe,
gaps and reconnect with the package's default socket deadlines. Each subscribe names a
request id, and its acknowledgement echoes that id and the accepted `after` cursor. Replay
failures retry that thread alone without dropping healthy subscriptions. `toError` keeps
retryable server errors as ordinary errors (like connection errors and replay deadlines),
while refusals become `CliError("protocol")`. Both `createObserver` and `subscribeThread`
leave the former with shared recovery until the command deadline and terminate on the latter;
there is no CLI retry loop. Actual terminal/auth socket closes still end pre-proof observation
with exit 4. A failure after proof cannot erase it (`observationIncomplete: true`). A CLI queue bounds
waits by the command deadline; never add CLI socket timers or tune the package's
deadlines to `--timeout` (see the
[deadline contract](../../../packages/thread-client/.context/CONTEXT.md)). Terminal
and auth closes are exit 4. `stream.ts` is the journal printer for `events` and plain
`tail`; `events-map.ts` (`RunEventMapper`) folds events into the dotted
lines `events`, `send` and `tail` print, and decides nothing about what a turn
contains. It carries no run identity: `turn.started` has only the turn id.

- **Busy, owed and blocked** come from the run-state record
  (`liveState.runState`, `subscribed`, `meridian.run_state`) through the package's
  selectors (`isBusy`, `isOwed`, `usageBlockedMessages`, `writerMessages`), the same
  the app uses; `commands/thread/run-state.ts` only holds the view.
- **`send`** admits (a lost HTTP admission answer is recovered with one app-route lookup,
  `submissionId`; a failed lookup or pending admission is 6 `admission_unknown`), raises the
  cell's floor to the admission's `snapshotFloorNextSeq` (`acknowledgeAdmission`), then starts the
  sync, which asks for the first read and joins on it. The stream only decides when to look: the
  subscribed state, a `meridian.run_state` or `meridian.messages.handed_back` frame, or a gap
  calls `sync.refresh()`. Every claim is the shared `messageFate`
  over one applied read's response whole (`messageFate({ messageId, admittedVersion, read })`;
  never the synced value, whose turns and record come from different frames) plus the
  admission's `runStateVersion`: waiting, answering, answered, handed back, unproven. One
  projection turns the fate into a final result frozen with that read. The claimed turns for
  `liveView` are the assistant turns of the message's chain in that read. At the deadline no read
  starts, the one in flight is aborted, and the last applied read is classified
  (`snapshotStale`, or `snapshotUnavailable`). The result is the chain's last reply (`turnId`),
  the reply that took the message (`answeredBy`) and `userTurnId`. A settled claim gives the
  stream a bounded 1.5 s for claimed terminal turns to be stream-ended and checked
  (no delivery-cursor barrier) (the stream ending a turn makes the sync ask for a read, which checks it); the
  printed log is best-effort. A timeout or expected read/transport failure in catch-up never changes
  the claim: `observationIncomplete: true` records unfinished observation. Check results still
  determine `liveView` independently; neither a clean check nor a completed catch-up certifies
  the whole printed journal. The command ends within catch-up even if a read is still pending.
- **`stop`, `queue hand-back`, `queue send-now`** run the shared `@meridian/thread-client`
  hand-back operation and `postSendNow`; `./mf` contributes only
  `commands/thread/hand-back-adapter.ts` (one command in memory, the HTTP port over the session,
  a local `RunStateView`, no-op `removeTurns`, printing and exit codes). The frozen request and the exact
  `--replay` command go to stderr before every post, even under `--json`. The operation classifies
  the answer: a 2xx validated in full by the contract's response schema (blocks, id arrays, the
  whole run-state record) is confirmed (0); a 400, 404 or 409 is refused (1); no answer, a 5xx, an
  oversized, non-JSON or malformed body is ambiguous (4, request in `details` and the hint). Only
  `--replay <request>` (same body, no new snapshot) recovers it; a plain re-run is a new press.
  `stop` uses `stopRequest` over a snapshot (`mine: []`); `queue hand-back --id/--all` posts
  `{requestId, ids}` (`--all` = `waitingWriterMessages`, browser messages included) and reports ids
  the server covered in no list as `ignored` (exit 1, `not_a_message`); `queue send-now` posts
  `sendNowRequest`, and a null `cancelledExecutionId` means "this attempt requested no
  cancellation", never that the reply kept running. **`cancel --turn`** serves a handoff brief's
  Stop only.
- **`tail --until-idle`** starts the sync and waits for its first applied read, which joins
  the stream (it refuses `--since`: the follow joins from its own read; `events --since` and
  plain `tail --since` still replay the journal). It returns after that read if the chat is
  already idle. Otherwise a record, the subscribed state or a status frame calls
  `sync.refresh()`, and an applied read with `isBusy` false and `status.kind: "asleep"` is idle,
  frozen as the proof. The claimed set is frozen with that read: unfinished assistant turns in the join read,
  assistant turns added by the proving read, and turns frames or states named before proof.
  Later frames never expand it. Result, pending checks and `liveView` use this same set. Any observed failure or covered turn error is failed; otherwise any cancellation is
  cancelled; missing or non-terminal turns are 6 `unconfirmed`; all complete is complete. A gap
  counted against the claim without a proven failure or cancellation is 6 `replay_truncated`.
- **Deadlines never prove idle.** A timeout is exit 124 with the last snapshot
  (`snapshotStale: true`, or `snapshotUnavailable: true` if none), never an
  extended deadline. With a snapshot the report carries `stillRunning`, `owed` and
  `next`; absent means unknown, not none. `classifyDeadline` (`result.ts`) picks the
  reason in order: `running`, `owed`, `lease_awake` (neither, but `status.kind` is
  still `awake`: the record and the status disagree, so idle is unconfirmed; check
  again with an until-idle tail, never poll to hide it), then `unconfirmed`.
- **Removals and dividers are fenced by seq**, as in the app, because they are the sync's
  rules. A `meridian.messages.handed_back` frame tombstones its turns at its seq, and a
  `meridian.write_mode.switched` divider installs after its anchor turn. When the anchor is a user
  turn the stream never carried, the sync holds the divider out and asks for a read; it never
  inserts the divider at the tail. `./mf` has no recovery code of its own.
- `thread answer` uses the shared durable-ask command over the socket and prints the resolved ask. Its answers are one `--answer option:<label>|text:<words>|skip` per question, in order, or `--answers` JSON. `thread presence` sends the takeover's `ask.presence` (held answers, `none` for unanswered) over the same socket and waits 300 ms for it to flush, since the server sends no reply.
  `events` on a replay gap is 6 `replay_truncated` after printing. Tool results distinguish staged
  `tool.completed` from committed `tool.settled`.
- Message admission builds one paragraph with `buildMessageDoc` and
  `serializeMessageDoc` (reference labels and image capability from the address
  route's catalog entry). Reference lookups run sequentially: a failed lookup leaves no
  sibling request running after command return. This exercises the app's serializer, not the TipTap
  editor or its submission lifecycle.

JSON fixtures live in `fixtures/`; TypeScript in `src/`. The root Vitest project
list includes this package's config once; `pnpm test` runs every CLI test, and the
package's Nx test target is for focused runs only. Cached Nx `typecheck` and `test`
include the shared Portless helpers and the root shim as inputs.
