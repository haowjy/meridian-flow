# Debugging

Start from your symptom in [Strategies](#strategies), or scan the
[Toolbox](#toolbox) for what each surface gives you. Detail sections follow;
[Adding Observability](#adding-observability) covers emitting new signals.

## Toolbox

| Tool | Reach for it when | Detail |
| --- | --- | --- |
| Temporary console probes | You need a one-off signal from a live bug, now | [Temporary Probes](#temporary-probes) |
| `EventSink` / `emitEvent` | The signal would help another agent tomorrow | [Durable Logs](#durable-logs) |
| `./mf` | An agent needs setup, durable reads, mock-model scripts, or a quick check of the code `./mf` shares with the app. Debugging evidence only; verification is a browser run | [Set Up and Debug with the CLI](#set-up-and-debug-with-the-cli) |
| `./mf log` | An agent needs bounded JSON for one known event/trace/domain id | [Consume Server Events](#consume-server-events) |
| `./mf thread context` | An agent needs the model's canonical request, digest, or tool-loop prefix | [Inspect Model Context](#inspect-model-context) |
| `GET /api/debug/events` | Query recent server events by correlation/source/level | [Consume Server Events](#consume-server-events) |
| `GET /api/debug/events/stream` | Live SSE tail while reproducing | [Consume Server Events](#consume-server-events) |
| DebugOverlay → **LLM Calls** | Inspect gateway calls plus Markdown, Raw, and Debug request views | [Inspect Model Context](#inspect-model-context) |
| DebugOverlay → **Streams** | Client Yjs / thread-socket traces; toggle in the server feed | [Durable Logs](#durable-logs) |
| `logs/events/*.jsonl` + `jq` | Post-restart forensics; best-effort mirror | [Consume Server Events](#consume-server-events) |
| `logs/portless.log` | Authoritative interleaved stdout | [Durable Logs](#durable-logs) |

## Strategies

- **An agent run failed.** Query `?threadId=<id>&level=error` — `turn.error`
  records carry the gateway error and correlation. Pivot to
  `?gatewayCallId=<id>` for the call's full lifecycle, then expand the call in
  the LLM Calls panel if you need request-level detail.
- **A provider refused or failed a call** (out of balance, bad key, unknown
  model). Start with `./mf thread view <id>`: the failed reply shows the
  provider's HTTP status and message under its failure reason (see
  [Provider Failures](#provider-failures)).
- **Something is slow or chatty.** LLM Calls panel first (latency, retries,
  token counts per call). For per-chunk granularity, opt into
  `OBS_VERBOSE=gateway.chunks` (dev/test only) and re-run.
- **Client work looks slow in a development build.** Compare it with the
  production client against the same dev server and database:

  ```bash
  MODEL_PROVIDER=mock pnpm dev:production-client --no-tailscale
  ```

  This builds the app, serves its hashed production assets at the checkout's
  usual Portless app URL, and keeps the dev login, same-origin `/api`, and
  WebSocket routes connected to that checkout's dev server. Portless supplies
  its CA through `NODE_EXTRA_CA_CERTS`; the launcher refuses to run without it
  rather than disabling TLS verification. A running stack records which client
  build it serves and refuses reuse with the other build. Use `pnpm
  dev:production-client --restart --no-tailscale` to switch from the development
  client or rebuild after source changes. `pnpm dev:restart` keeps the current
  client build. Stop it with `pnpm dev --stop`.
  Record the commit, browser version, fixture, sample count, host load, and
  whether each number came from `pnpm dev` or `pnpm dev:production-client`.
- **The server stalls** (acks stop, requests hang, the editor goes offline).
  Find the busy thread before reading a profile. `nitro dev` runs the server in
  a worker thread, so a CPU profile of the process's main thread reads idle
  while the worker is pegged, which looks like a lock wait. Sample per-thread
  CPU (`/proc/<pid>/task/*/stat`) and `pg_stat_activity` for lock waits, then
  profile the thread that is busy.
- **An LLM is debugging.** Reproduce with `./mf thread send` (pair
  `MODEL_PROVIDER=mock` with `./mf mock script` for deterministic tool paths).
  A `./mf` run is debugging evidence for the code it shares with the app and for
  the server. Verify what the writer sees with a browser run (`agent-browser`) at
  the end. Read the durable transcript with `./mf thread view` to check
  what the writer's transcript holds (a `send` already proves which reply answered
  its message), then `./mf log --thread <id>` or
  `./mf log --trace <id>`. Add `--full` only when compact metadata is
  insufficient. Use `./mf thread context` when the question is what the model
  received rather than what the runtime did.
- **It broke and the server restarted.** The in-memory ring is gone; fall back
  to the JSONL mirror with `jq`, remembering it is best-effort and bounded.
- **Polling from a script or agent.** Use `sinceEventId` cursors — event IDs
  are stable at emit time, so incremental polls never re-read history.

## Set Up and Debug with the CLI

While working, `./mf` is the first line of defense: it reproduces and debugs,
sets up state (Works, threads, seeded documents, mock-model scripts, queued
controls), reads durable state and server logs, and checks the code it shares
with the app against the real server. Verification is a browser run, driven by a
prober with `agent-browser`, judged by what the screen shows with the durable
transcript as truth. Repeatable recipes live in the
[runtime probe catalog](qa/README.md).

`./mf` (repo root) drives this worktree's own API: every command maps to an
existing HTTP route or thread-socket message, authenticated exactly like the
browser through dev login. Run `./mf` for the command tree with the route each
command wraps, and `./mf <noun> <verb> --help` for flags and examples.

What a `./mf` run proves depends on the code behind the command. Its thread
socket, message body, chat event processing and transcript view model come from
`@meridian/thread-client`, the same code the app runs, so a run is debugging
evidence for that shared code against the real server (`thread view` prints the
rows the app draws). A command with no shared client code behind it is evidence
of the server only. Neither stands in for the browser run, which checks what the
writer sees: rendering, card wording, the app's thread store, the TipTap
composer, the submission journal, optimistic UI, and navigation. Every PR that
changes anything a writer's experience runs through, server-only changes
included, ends with that run and its screenshots.
`liveView` is not a certificate of any browser screen.

A send that cannot start for lack of usage returns `status: "blocked"`,
`outcome: "failed"`, `reason: "credits_exhausted"` and exit code 1, not a
deadline timeout. This proves that this send's accepted writer turn is still in
the durable blocked inbox; it does not discard the message. Adding usage lets
the existing server wake retry it.

```bash
./mf seed tools/mf/fixtures/basic.json        # docs + thread + an opening message
./mf thread send <id> "Tighten the opening" --ref manuscript://mf-chapter-1.md
./mf thread send <id> "go" --mock @tools/mf/fixtures/mock-write.json --json | tail -1
./mf thread view c3                                # chat rows as the app draws them (ref, id, or id prefix)
./mf thread tail <id> --until-idle                 # follow a run started elsewhere
./mf thread stop <id>                              # the chat's Stop (hands waiting messages back)
./mf thread queue hand-back <id> --all             # take every queued message back (never cancels the reply)
./mf thread queue send-now <id>                    # ask the server to cancel the reply the snapshot shows (the queue can then run)
./mf thread events <id> --child p2                 # one direct child's status, phase, tool, and target per activity frame
./mf thread view <id> --blocks                     # persisted blocks with created time, gaps, tool name, size
./mf doc read manuscript://mf-scene.md
./mf api GET /api/threads/<id>/skills              # any route without a dedicated command
```

Contract:

`./mf thread stop`, `thread queue hand-back` and `thread queue send-now` run the same operation the
app runs (`@meridian/thread-client`'s hand-back operation and `postSendNow`), each over a fresh
snapshot. They print the frozen request and its exact `--replay` command to stderr before posting,
even under `--json`. A 2xx counts only when the whole answer validates; a lost or malformed answer
exits 4 with the request in the error, and `--replay` re-sends it unchanged (a plain re-run is a new
press built from a newer record). A 400, 404 or 409 exits 1.
- `queue hand-back --id <turn>... | --all` proves what the *server* did with each id: `handedBack`,
  `answered` (the reply took it first) or `gone` (another request took it). An id in none of them is
  `ignored` (exit 1, reason `not_a_message`). `--all` sends every message the snapshot shows queued,
  browser messages included; with none it posts nothing and says only that the snapshot showed none.
- `queue send-now` exit 0 means the server confirmed its control answer, not that the queue was
  answered: follow with `thread tail --until-idle` or `thread view`. A null `cancelledExecutionId`
  prints "this attempt requested no cancellation". It says nothing about the reply's fate (a replay
  of a Send now that already cancelled also answers null), so never read null as "the reply kept
  running". These commands read state; the browser is where the queue's behavior is checked.

`./mf thread send` proves, from one snapshot read through the shared `messageFate`,
whether its own message is waiting, was handed back, or was answered, and by which reply.
Its result is the status and text of the last reply in that message's chain,
continuations and Retries included. When it can't prove that, it exits non-zero with a
reason. The stream only decides when to look: no frame is an input to the claim.
`tail --until-idle` confirms idle at its final snapshot; it does not attribute replies to
messages. Plain `tail` and `send`'s live output don't draw queued rows.

- Content comes from the app's own event processing. `thread view` runs the shared
  `viewTranscript` directly over a snapshot, and prints that view model's rows (`you:`,
  `reply: 3 steps, read 2 docs`, `compaction:`, `queued:`), or `--json` as the
  versioned `chatView: 2` envelope with row identity, kind and items (`--full --json` adds
  tool inputs, results and metadata, Work receipts, raw card content, report payloads, the
  handoff brief, delivery bodies and writer occurrences; text mode summarizes and omits
  them). Its `inputs` field says what the view was computed from: the snapshot only, with
  no local records, stand-ins, opening seed or live activity, inherited history omitted,
  and background report bodies and change trails not fetched. Card wording and failure
  copy are drawn by React, so compare cards as raw props only. The app draws
  the same function's output, so compare a chat in the browser by row identity, row
  kind, item kinds and visible text with [the chat-session recipe](qa/chat-session.md). `send` and `tail --until-idle` run the app's
  `ThreadSync`: the same read-first join, read application, frame ordering and missing-row recovery.
  Each result is proved by one applied snapshot, not by the mixed-version client value.
  `liveView` is a separate end-of-turn diagnostic: when stream frames end a turn, its next applied
  read compares that turn's status and text. The result is `matches`, `differs` (with `liveDiff`),
  or `not_observed` with `liveReason`. A read that seeded text, rewrote a streaming turn or ended
  it first permanently prevents a stream claim for that turn; a tail joining mid-reply commonly
  reports `rewritten`. An empty claimed assistant set reports `no_turn`.
  - These checks do not certify browser rendering, tools, reasoning, interrupts, optimistic UI,
    row placement, queued rows or dividers. Verify the screen with [the browser recipes](qa/chat-session.md).
  - Neither `matches` nor `differs` changes the proven outcome or exit code. A disagreement is
    a debugging lead, not an automatic exit 6. The guarantee and its limits are in
    [`./mf` claims are proofs][mf-claims].
  - Retryable replay errors and replay deadlines recover through the shared transport until
    the command deadline. A refused replay ends the command; terminal/auth socket closes remain
    exit 4. The CLI owns no replay retry loop.

  `thread events` stays an event log and prints both `tool.completed` and
  `tool.settled`.
- Compact text by default. `--json` prints one object, or NDJSON for streams.
  Every live claim (`send`, `tail --until-idle`, `respond`, `stop`, `cancel`, and each seed send)
  and `events` ends in a `result` envelope. Seed embeds its sends' envelopes in
  `messages` and reports the worst exit among all sends in its final result.
  `--fields a,b` keeps `type` on every stream line and always keeps `type`,
  `command`, `outcome`, and `reason` on terminal results. CLI errors (usage,
  not found, unavailable) remain on stderr (`{error, code, hint}` under `--json`).
- Outcomes map to exits: **0 accepted** (`send --no-wait`, admission only) and
  **0 complete**, **1 failed**, **5 cancelled** and
  **5 handed_back** (`outcome` tells them apart), **6 unproven**, **8 interrupt**, **124 timeout**. Other exits: **2 usage**,
  **3 not found**, **4 unavailable** (stack, login, terminal socket close).
  `reason` is null for a proven outcome, except a `failed` send whose message the chat moved past (`forgotten`: no reply answers it). A timeout's reason names the first
  thing its last snapshot still showed: `running` (a running turn), `owed` (a
  pending writer message), `lease_awake` (the chat still awake with neither,
  as when a restart orphans a reply and the server keeps its run lease until
  expiry, [#799](https://github.com/haowjy/meridian-flow/issues/799)), else
  `unconfirmed` (no snapshot, or one that looked idle but proved nothing).
  `send` and `tail --until-idle` share this rule.
  Unproven reasons are `admission_unknown`, `deliverer_unknown` (the message
  left its queue with no reply that took it), `unconfirmed` (the snapshot
  contradicts itself, such as a last reply neither running nor finished), and
  `replay_truncated` (tail and events). `owed` survives only as a timeout reason.
- In text mode, a final answer goes to stdout only for complete or failed.
  Stderr reports `<outcome> <turn> [reason]` and any follow-up commands. A
  `handed_back` send prints nothing on stdout and
  `handed_back <userTurnId> (a Stop returned this message before any reply took it)` on stderr.
  A failed or cancelled run is a `result`, never a terminal `error` record.
- A send deadline classifies the last snapshot that completed and starts no new read, as
  `tail --until-idle` does: the result says `snapshotStale: true`, or
  `snapshotUnavailable: true` (reason `unconfirmed`) when no snapshot had completed. It
  reports `stillRunning` (turn id and status, or null), `owed` (pending writer
  messages), and `next` commands. The run-state record (`liveState.runState`) is
  a mandatory live-state field. Text says when the server is
  still running and how to stop it (`./mf thread stop <thread>`). **Timeout never cancels a run.** Plain
  `tail` remains a bounded live view and exits 0 when its wait expires.
- `tail --until-idle` returns immediately if the initial snapshot is idle.
  Otherwise it follows through the shared sync, which requests snapshots on terminal
  turn writes and run lifecycle events. Tail also requests a snapshot when a
  `meridian.run_state` record or the subscribed state shows no open execution and no
  writer message, or a `meridian.thread.status` frame arrives. A frame triggers a read;
  it never proves idle on its own. Idle means
  the shared run-state module's `isBusy` is false for the snapshot's `liveState.runState` (no open
  `execution`, no writer-provenance message in `items`) and `liveState.status.kind` is `asleep`
  (no awake lease). A successor run or owed writer message keeps it
  following until a snapshot confirms idle or the deadline exits 124 with the
  timeout report. Durable `thread.status` alone is not evidence of idle.
  One subscription and event mapper stay alive through checkpoints, including
  frames arriving during HTTP confirmation. At the proving read it freezes its `turns` list:
  unfinished assistants at join, assistants first stored during the follow, and pre-proof
  stream-named turns. Result, pending checks and `liveView` use exactly that set; later turns
  cannot join the proof.
  Any observed failure or covered turn error produces failed; otherwise any
  cancellation produces cancelled, missing or non-terminal turns produce 6
  `unconfirmed`, and all complete produces complete.
  A replay gap without a proven failure or cancellation produces 6
  `replay_truncated`, preserving the idle evidence and covered turns. An initially idle chat returns complete with an empty list.
  Snapshot requests use only the time remaining. At timeout, the last snapshot's
  activity is labeled `snapshotStale: true` (not a new current-state claim),
  or `snapshotUnavailable: true` if no snapshot succeeded. Without a snapshot
  the result carries no `stillRunning` or `owed`: absent means unknown, never
  none. No post-deadline snapshot request extends the wait.
- `stop` is the chat's Stop: it builds the app's body with `stopRequest` from a snapshot's
  record (`seenThrough`, `seenExecutionId`, `mine: []`) and posts it to the Stop route. Before
  posting it prints the request (id and frozen body) to stderr in text mode; the complete
  envelope carries it as `request`. The envelope proves the server's answer:
  `cancelledExecutionId`, `handedBack` (user turn ids; the blocks with `--full`), `answered`,
  `gone`. `--full` text mode also prints each handed-back message's text in send order, blank
  lines between. The envelope is printed only for an answer that passes the contract's
  `stopResponseSchema` in full (hand-back blocks and id arrays included). Anything else leaves
  the Stop possibly landed: timeout, connection failure, a 5xx, an answer over the 20 MiB
  response limit, a body that is not JSON, or a malformed one (such as a null block). It exits 4,
  and the error says how to replay and carries the request (`details.request` under `--json`).
  Only a 4xx refusal is reported as one, with no replay. **Never re-run it plain**: that
  is a new press, takes a new snapshot and request id, and can cancel the next reply while the
  first press's handed-back text is lost. `--replay <request.json|@file|->` posts exactly the
  printed request, no new snapshot; the server returns its stored decision with the
  handed-back content. Follow it with `./mf thread tail <thread> --until-idle`. The text comes
  back in this output, not in a browser's composer.
- `cancel --turn <id>` (required) serves a handoff brief's Stop. Its complete envelope proves
  the server acknowledged cancellation or reported the target already finished, not that a
  reply was answered. Its `status` carries that acknowledgement. A missing target keeps exit 3.
- `respond` exits 0 only after the journal records `meridian.interrupt`
  resolved for that interrupt id. A rejecting error frame exits 1; its
  confirmation deadline (`--timeout`, default 15s) exits 6 `unconfirmed`.
  It does not prove the reply that follows.
- `events` prints the replay, then exits 6 `replay_truncated` if a gap arrived.
  Otherwise its complete result proves only that the printed replay had no gap.
- If a message POST loses its HTTP answer, send looks up its `submissionId`
  once through the app's admission route. Accepted resumes following; rejected
  or not seen exits 1; a failed lookup or still-pending admission exits 6
  `admission_unknown`. `send --no-wait` proves admission only and reports `outcome: "accepted"`, never `complete`.
- A `send` follows one subscription and, on each trigger (the subscribed state, a
  `meridian.run_state` or `meridian.messages.handed_back` frame, `interrupt.requested`, a
  gap), reads a snapshot and runs `messageFate` on it. What the fate means:

  | Fate | `send` |
  | --- | --- |
  | message waiting | keeps following (blocked for usage: exit 1 `credits_exhausted`) |
  | answering, interrupt raised | exit 8 with `interrupt` |
  | answered | the last reply in the chain sets the outcome: complete 0, failed 1, cancelled 5; `turnId` is that reply, `answeredBy` the reply that took the message |
  | forgotten (the turn carries `forgottenBy`) | exit 1 `forgotten`, `turnId` null: the chat moved past its failed reply, so nothing answers it |
  | handed back (not in the snapshot) | exit 5 `handed_back`, `turnId` null |
  | no deliverer | exit 6 `deliverer_unknown` |
  | snapshot inconsistent | exit 6 `unconfirmed` |
  | deadline | exit 124, `turnId` from the last answering fate |

  Only the last reply sets status and text, so a failed successor never borrows an earlier
  success. When later messages join the same execution, the execution's last reply answers
  all of them. A Retry pressed after `send` reported failed isn't waited for; use
  `tail --until-idle`. A gap marks `liveView` `not_observed` and never weakens the claim.
  After a claim settles, observation gets up to 1.5 s within the command deadline to collect
  pending shared-sync checks. This is not a journal-watermark wait or a complete-log guarantee.
  Expected HTTP, transport or protocol failures during this diagnostic phase preserve the
  proven result and set `observationIncomplete: true`; existing checks still determine `liveView`.
  A later replay cannot restore a rewritten turn's standing as stream evidence.
- Write tools emit `tool.completed` for the staged result, then `tool.settled`
  for the committed receipt, in both JSON and text. There is no `settled` flag.
  The staged result alone does not prove a committed write.
- `thread view` (`chatView: 2`) prints a compaction row as its trigger, control
  ID, summary and model, and token counts before and after; `--json` carries the
  same facts under `compaction`. It does not print a failed compaction's reason
  or phase, or fit tokens (`error` remains writer-facing copy). Those live on the
  compaction turn's durable `metadata` (`reason`, `phase`, `estimatedTokens`,
  `fitLimitTokens`), in the thread snapshot's turns. Neither `thread events` nor
  `./mf log` carries them today. The view model should carry them if a CLI
  reader needs them; that is not built yet.
- `<thread>` accepts a `cN`/`pN` ref, a full id, an app URL containing one, or
  a unique id prefix. Refs are per project: they resolve through
  `GET /api/projects/:projectId/threads/by-ref/:ref` in the default project,
  or in `--project <id>`.
- `MF_SERVER_URL` plus `MF_COOKIE` (or `MF_APP_URL` for dev login) target a
  stack other than this worktree's Portless routes.

Terminal record example (command-specific fields follow the reserved keys):

```json
{"type":"result","command":"thread.send","threadId":"…","outcome":"timeout","reason":"running","stillRunning":{"turnId":"B","status":"streaming"},"owed":[],"next":["./mf thread stop …","./mf thread tail … --until-idle"]}
```


### Real model for a live run

`LIVE_TEST_MODEL=<registry model id>` (for example `deepseek-flash`, with its
`FLOW_DEEPSEEK_API_KEY` set) sends every model call to that one model, whatever a
chat, Agent or binding names, including models whose provider has no key. Stored
state keeps the names it has. Restart your stack to change it. Production refuses
to start with it set; staging allows it.

### Mock provider responses

`MODEL_PROVIDER=mock` selects a local HTTP model server hosted inside the app
server process. It makes no paid model calls. A **fixture** is a JSON script of
model responses. `--mock @file.json` supplies one for a single send and requires
the server to use the mock provider; on a real-provider server the CLI refuses
before admitting the message. It does not switch providers.

Without a script, the dev provider streams an authored fiction scene with
thinking. Choose a different default with `MOCK_MODEL_RESPONSE`, a JSON
object using the same content and pacing fields as a script step:

```bash
MODEL_PROVIDER=mock MOCK_MODEL_RESPONSE='{"sample":"critique","chunkDelayMs":30}' pnpm dev
MODEL_PROVIDER=mock MOCK_MODEL_RESPONSE='{"lorem":{"words":10000},"chunkSize":256,"chunkDelayMs":10}' pnpm dev
```

Changing startup environment requires restarting your stack. Defaults cannot
contain tools, errors, finish reasons, or `times`: a repeated tool call would
never reach a final answer. Use a multi-step script for those scenarios.
Explicit scripts win over built-in trigger phrases, which win over the default.
For example, a matching script that says `{"text":"Hello"}` makes a message
containing `Phase 7 final gate` return Hello instead of triggering a write.
Existing fault triggers include `slow before output`, `slow after output`,
`midstream disconnect`, `hang cancel drain`, and `cancel billing`.

#### Script a response

Use `./mf mock script` to queue fixtures; it calls
`/api/debug/mock-model/script`. The route needs the debug gate (`APP_DEBUG=1` in a
non-production environment, set by `pnpm dev`). Each step answers one **model call**, not one
user message. A tool step causes real tool execution, followed by another model
call, so finish a tool workflow with a text step.

```bash
# One CLI send, scoped to its user message and cleaned up when the command finishes.
./mf thread send <id> "Critique the opening" --mock @tools/mf/fixtures/mock-thinking.json
./mf thread send <id> "Long response probe" --mock @tools/mf/fixtures/mock-large.json --timeout 120s
./mf thread send <id> "Scratch workflow probe" --mock @tools/mf/fixtures/mock-tools.json

# Queue for messages you type in the browser. Four samples, one per model call.
./mf mock script @tools/mf/fixtures/mock-samples.json --match "sample probe"
./mf mock list
./mf mock clear --id <scriptId>
```

A script is `{ "match": "optional message substring", "steps": [...] }`;
a bare step array is also accepted. `match` compares the latest user message
on each model call. Give concurrent probes distinct message text: identical
messages in different chats can consume the same script. Unmatched calls use
the provider default. `mock clear` without `--id` removes all queued scripts.

#### Response controls

Choose at most one of `text`, `sample`, and `lorem`. Thinking and tools can
accompany any of them. Unknown fields and conflicting text sources are rejected.

| Field | Effect |
|---|---|
| `text` | Exact assistant Markdown, up to 1,000,000 characters. Supports headings, lists, quotes, code fences, links, and Unicode. |
| `sample` | `scene`, `critique`, `outline`, or `markdown`. Authored samples with thinking, not recordings and not answers tailored to the prompt. |
| `lorem` | `{ "words": 10000, "wordsPerParagraph": 100 }`. Exact whitespace-separated word count, up to 100,000; default paragraph size 80. |
| `reasoning` | Thinking text before the answer and tools. Overrides sample thinking; `""` disables it. Thinking alone is also accepted. |
| `repeat` | Repeat literal or sample text 1–100 times, separated by blank lines; bounded to 2,000,000 characters with reasoning. For lorem, set `words` instead. |
| `delayMs` | Wait 0–120,000 ms before starting the response, including errors. |
| `chunkSize` | Unicode characters per text, thinking, or tool-argument chunk; 1–65,536, default 24. |
| `chunkDelayMs` | Interval between chunks, 0–10,000 ms. Scripts default to 0 (burst output); without `MOCK_MODEL_RESPONSE` or a matching script, the dev default uses 20 ms. Approximate character rate is `chunkSize * 1000 / chunkDelayMs`; network and application processing add overhead. |
| `toolCalls` | `[{ "name": "read", "args": { "path": "scratch://Mock scene" } }]`. Up to 100 calls; names and arguments go to the real tool registry. `rawArgs` instead of `args` sends the arguments string as is, for a malformed-JSON tool call. |
| `finishReason` | `length` for truncation or `content_filter` for a filtered response. Sends all supplied text, then marks the response failed; the partial text remains above a failed-response card. Does not shorten text for you. Omit for normal completion or tool execution. |
| `error` | `{ "status": 503, "message": "Unavailable" }` instead of content. Cannot be combined with response content or streaming controls. |
| `times` | Number of model calls consuming this step (1–1,000). An error without `times` keeps answering every matching call, including retries, until the script is cleared. |

For example, this produces a long answer slowly without storing a large fixture:

```json
{
  "steps": [{
    "sample": "scene",
    "repeat": 20,
    "reasoning": "I will build the chapter around the cost of Mei's choice.",
    "delayMs": 500,
    "chunkSize": 64,
    "chunkDelayMs": 25
  }]
}
```

Large, slow responses may exceed the CLI deadline or the gateway's model-call
ceiling (default 900,000 ms). The default inactivity limit is 60,000 ms. Increase `--timeout` for the CLI and `MODEL_CALL_TIMEOUT_MS` for the
server when deliberately exercising long runs; a chunk interval above
`MODEL_CALL_STALL_MS` deliberately exercises a stalled provider. `chunkDelayMs`
has no effect on non-stream responses. Stop/disconnection releases pending mock
output and timers. Synthetic token usage is based on request/output bytes, not
real tokenization or provider pricing.

The mock uses the Chat Completions wire format: thinking, one text channel,
then tool calls. Markdown formats are text, not separate provider blocks.
It does not simulate arbitrary interleaved Anthropic/Responses blocks or
assistant image/audio/file output. Tool results and document receipts come
from the real runtime, not fabricated model output.

#### Ready-made scenarios

- [Thinking and critique](../tools/mf/fixtures/mock-thinking.json): paced thinking followed by a formatted critique.
- [Large output](../tools/mf/fixtures/mock-large.json): 10,000 lorem words with paragraph breaks.
- [Sample rotation](../tools/mf/fixtures/mock-samples.json): scene, critique, outline and Markdown on four model calls. Queue with `mock script`; `send --mock` removes unconsumed steps when that send finishes.
- [Document tools](../tools/mf/fixtures/mock-tools.json): create/overwrite `scratch://Mock scene`, then read, list and grep it, followed by a final answer. The fixture fixes this path in the current chat's Scratch, not manuscript files. Read it with `./mf doc read "scratch://@<chat-ref>/Mock scene"` (for example, chat ref `c7`).
- [Retry recovery](../tools/mf/fixtures/mock-recovery.json): one 503, then a successful outline. The gateway is the only retry layer; provider SDK clients use `maxRetries: 0`.
- [Truncated response](../tools/mf/fixtures/mock-truncated.json): a partial sentence with the provider's length finish reason.
- [Provider failure](../tools/mf/fixtures/mock-provider-error.json): a sticky failure. Inspect the failed reply, not only the send exit code.

The `ask_user` tool is available in primary chats. Queue a tool call with the shape
shown in [the ask QA recipe](qa/ask.md); answer it with `./mf thread answer`.
It remains unavailable in child chats until question forwarding lands. A mock
script does not bypass tool availability or permissions.

To exercise another tool, replace `toolCalls` with its current name and
arguments; invalid arguments exercise the real refusal path. Scripts do not
interpret tool results or choose subsequent steps conditionally. For dynamic
handles or IDs, inspect the result and queue the next step explicitly.

Capture a run for later inspection. `--json` output is never truncated (only
text mode shortens tool payloads), so redirect it and query with `jq`:

```bash
./mf thread send <id> "…" --json > run.ndjson                     # stream and reported result; verify with thread view
./mf thread tail <id> --json > live.ndjson &                       # record a run started in the browser
./mf thread context <id> --all --view raw --json > context.json   # what the model received: system, tools, messages, params
./mf thread view <id> --json > snapshot.json                      # persisted transcript
jq -c 'select(.type | startswith("tool."))' run.ndjson             # tool calls with args and results
jq -c 'select(.name == "meridian.subagent.activity")' run.ndjson   # one custom event kind
```

Replays joined mid-message (`events --since`, `tail --since`) mark that
message `partial: true`, since its text is only the tail after the cursor.

## Provider Failures

When a provider answers a model call with an error, the failed reply keeps
its status and message:

```bash
./mf thread view <id>                          # status and message on the failed reply
./mf thread view <id> --turn <turnId> --full   # the stored message untruncated
```

```text
[assistant] 9475094e-… error/error in=0 out=0
  error: This response failed.
  failure reason: provider_error
  provider error (402): Insufficient Balance
```

The failed reply's `metadata.providerError` is `{ status, message }`, with
the message capped at 1,000 characters; `status` is null for a failure reported
inside the stream. Server events keep only `errorCode`, so provider text never
enters `EventSink`, JSONL, or model context. The retry policy is in the
[gateway context](../apps/server/server/domains/runtime/gateway/.context/CONTEXT.md#provider-errors).

## Debug Gate

Every debug path shares one server gate, `resolveDebugPathsEnabled` in
`apps/server/server/lib/env.ts`: model-request capture, `/api/debug/events`
(and `/stream`), the debug account-skill routes, and the mock-model script
queue. The rule is:

- Never in production: `APP_ENV=production`, or `NODE_ENV=production` with
  `APP_ENV` unset or `dev`. The flag cannot override this.
- Everywhere else (dev, test, staging), only with an explicit `APP_DEBUG=1`.
  `pnpm dev` sets it unless `.env` sets `APP_DEBUG` itself. A staging deploy
  opts in by setting `APP_DEBUG=1` in its environment.

Dev login is separate and stays non-production only, so `./mf` against a
deployed staging server authenticates with `MF_SERVER_URL` plus `MF_COOKIE`
(a real session cookie).

## Temporary Probes

Disposable console probes for understanding a live bug quickly: delete them
before pushing, or convert the signal into durable observability. Use this
exact shape:

```ts
// TEMP-DEBUG: remove before push
console.log("[temp-debug:runtime.turn]", { threadId, turnId, state });
```

Rules:

- Put `// TEMP-DEBUG: remove before push` immediately above the console line.
- Prefix the message with `[temp-debug:<area>]`.
- Log one compact metadata object.
- `pnpm check` and pre-push block `TEMP-DEBUG`, `[temp-debug:...]`,
  `console.log(`, and `console.debug(` in product source, even when the console
  call is unmarked. They also block permanent `console.info`, `console.warn`,
  and `console.error` calls in server product source.
- Do not log secrets, cookies, raw prompts, raw model output, uploaded content,
  tool arguments, or tool results.
- Remove the probe before pushing, or convert it into durable observability.

## Durable Logs

If the signal would help another agent tomorrow, use structured observability
instead of `console.log`.

- Server diagnostics go through `EventSink` / `emitEvent`.
- Stdout is authoritative and lands interleaved in `logs/portless.log` during
  local dev. The dev stack pins `LOG_DIR` to the absolute repo-root
  `logs/events/` directory, so its best-effort daily JSONL mirror lands at
  8 MiB segments under `logs/events/` regardless of each service's working
  directory. An absolute `LOG_DIR` override is honored; relative overrides are
  ignored. Segments are pruned after 14 days and when the worktree exceeds
  128 MiB (`LOG_MAX_BYTES` overrides the byte cap). Allocation, append, and
  pruning share a worktree lock so overlapping server generations keep both
  ceilings hard. This is not an audit log.
- Nitro's active dev watcher is Rolldown's module-graph watcher
  (`rolldownConfig.watch` in `apps/server/nitro.config.ts`); it excludes
  `logs/` and `**/node_modules/**`. App Vite has its own ignore predicate for
  `logs/`. A reload during a long-running turn is a bug, not expected dev
  behavior. A rebuild can also come from inside the checkout (a source edit).
  These are written by the dev stack and are not watched inputs:
  `logs/portless.log`, `logs/events/**`, `.meridian/dev-session.json`, and
  Nitro output under `apps/server/node_modules/.nitro/dev/**`.
  `logs/portless.log` shows a rebuild (`[nitro] Server built` followed by a
  fresh `startup.complete`) but not what triggered it. Before blaming product
  code, confirm the running Nitro process belongs to this checkout and config,
  then capture the triggering path with a recursive `inotifywait` over the
  checkout (excluding `.git` only). Keep `node_modules`: a sibling worktree's
  `pnpm install` hardlinks shared store files and fires `IN_ATTRIB` there, so
  excluding `node_modules` hides that trigger.
- Each event is at most 8 KiB. The local output sink holds at most 5,000 pending
  events or 16 MiB. Output backpressure drops oldest first; the next successful
  write reports lost record and byte counts. The recent ring uses the same dual
  cap; process bootstrap is capped at 1,000 records or 4 MiB.
- Model-request diagnostics use a separate owner-gated, in-memory capture path.
  Protected prompt and tool content stays out of ordinary searchable logs.
- Client Yjs and thread-socket diagnostics are captured as metadata-only
  `EventRecord`s in debug-enabled builds. Open **Streams** from the debug pill
  for the live viewer, or use `window.__meridianTrace` for programmatic queries,
  stats, clearing, and next-event waits. API results are detached clones; caller
  mutation cannot alter retained evidence. Enable **Server feed** in Streams for
  process-side records, or use the HTTP surfaces below directly.

## Inspect Model Context

The LLM Calls pop-out joins metadata-only gateway lifecycle records to the
content-bearing request with `gatewayCallId`. Expand a call, select **Show model
request content**, then switch among **Markdown**, **Raw**, and **Debug**. The
Markdown tab shows the model's message sequence through the bounded readable
lens. Raw shows the captured provider-neutral `GenerateRequest`. Debug shows its SHA-256 digest,
capture status, resolved skills, tool provenance, and whether the previous
tool-loop request is an exact prefix.

For an agent or script, query the same endpoint and projection:

```bash
./mf thread context <thread-id>
./mf thread context <thread-id> --turn <turn-id> --all --json
./mf thread context <thread-id> --call <gateway-call-id> --view raw --json
```

The latest readable request is the default. `--iteration`, `--call`, or
`--all` selects other records; `--view readable|raw|summary` controls the
payload. Exact selectors transfer only the match and its immediately preceding
request for prefix comparison. The server verifies thread ownership.

Text output prints the readable Markdown (or the raw request) directly; under
`--json` each request begins with `markdown` or the exact canonical `request`,
followed by supporting debug metadata and the retention details.

This is the canonical request immediately before Meridian's gateway dispatch,
not a claim about a provider SDK's private wire encoding. Capture is enabled
with the debug gate (see [Debug Gate](#debug-gate)), lives only in process memory, and is bounded to 200 records,
2 MiB per request, and 16 MiB total. Oversized requests keep metadata and a
digest but omit their body. A server restart clears the ring. Request content
never enters `EventSink`, the event journal, thread snapshots, or JSONL logs.
Production can never enable this capture. The Readable lens contains
writer Markdown within explicit message boundaries and limits each projected
part to 32 KiB of UTF-8; Raw remains exact up to the request capture ceiling.

## Consume Server Events

For an LLM or script, prefer `./mf log`. It resolves the current worktree's
live Portless routes, performs dev login in memory, and never writes a cookie
jar:

```bash
./mf log --trace <trace-id>
./mf log --thread <thread-id> --level error --since 10m
./mf log --event <event-id> --full --json
./mf log --thread <thread-id> --follow      # polls with the sinceEventId cursor
```

Filters are `--event`, `--trace`, `--thread`, `--turn`, `--document`,
`--error-code`, `--source`, `--name`, `--level`, `--since` (duration or ISO
time), and `--limit` (default 50). Compact output omits payloads; `--full`
includes the sanitized records. JSON output includes dropped record/byte counts.
Failures exit nonzero with a hint.

A failed turn, a failed compaction or handoff brief, and a usage block each leave two
records: `failure.recorded` when the server classifies it, and `failure.ended` when it
stops applying. `./mf log --name failure.recorded` and `--name failure.ended` read them.
Both carry `occurrenceId` (the failed turn's id, or `usage:<threadId>:<episode>`),
`category`, `source` (`transport`, `refusal`, `provider`, `usage`, `validation` or `bug`),
`actionable`, `failureCode` (the typed reason; an untyped provider code is a `bug`),
`failureReason` (the error code, on `recorded` and on an immediate end, when it differs), `providerStatus` and `executionId`
where known. `failure.ended` adds `end` (`retried`, `forgotten`, `moved_on` or
`resolved`) and `byTurnId`, the turn that ended it. They are emitted after the
transaction commits, so a rolled-back settlement leaves none.

Servers with the debug gate open and the `local` event provider retain up to
5,000 sanitized records or 16 MiB in memory. Otherwise these routes return 404.

For direct `curl` access, bootstrap through the app and retarget the host-only
development session cookie to the paired server origin:

```bash
APP_URL=https://<lane>.app.meridian.localhost
SERVER_URL=https://<lane>.server.meridian.localhost
COOKIE_JAR=auth.cookies
curl -sS -c "$COOKIE_JAR" "$APP_URL/api/auth/dev-login" >/dev/null
sed -i 's/app\.meridian\.localhost/server.meridian.localhost/' "$COOKIE_JAR"
```

`GET /api/debug/events` returns newest first. Filters are `eventId` (exact),
`source` (exact), `name` (prefix), `level` (severity floor), `sinceEventId` (exclusive),
`sinceTimestamp` (inclusive), `limit` (default 200, max 1,000), and every
`EventCorrelation` key as an equality parameter.

```bash
curl -sS -b "$COOKIE_JAR" \
  "$SERVER_URL/api/debug/events?source=wire.yjs&documentId=X&limit=50" | jq .
```

`GET /api/debug/events/stream` is live-only SSE with the same record filters.
Each message carries one `EventRecord` as JSON in its `data` field; history stays
on the query endpoint.

```bash
curl -N -b "$COOKIE_JAR" "$SERVER_URL/api/debug/events/stream?source=wire.yjs&documentId=X"
```

After a restart, use the JSONL mirror for best-effort forensics:

```bash
jq -c 'select(.source == "wire.yjs" and .correlation.documentId == "X")' \
  logs/events/*.jsonl | tail -n 50
```

## Adding Observability

To make something new observable, emit an `EventRecord` through the composed
sink — everything downstream (query API, SSE, dashboard, JSONL mirror) picks it
up automatically:

```ts
import { emitEvent, unknownToEventPayload } from "../observability/index.js";

emitEvent(sink, {
  level: "info",                       // debug | info | warn | error
  source: "collab",                    // stable area name — a query filter
  name: "collab.checkpoint.collapsed", // dot-namespaced — name-prefix queryable
  correlation: { documentId },         // every key becomes a query parameter
  sensitivity: "safe",
  payload: { reason, cutSeq },         // compact metadata, never raw content
});
```

Conventions:

- `source` and a `name` prefix are your query handles — pick them like API
  names, not log strings.
- Put anything you'll want to filter by in `correlation` (ids, `errorCode`);
  `payload` is opaque to queries.
- For errors, `unknownToEventPayload(err)` keeps only error class/category,
  stable code, and approved scalar status. Messages, stacks, causes, SQL,
  provider text, prompts, tool data, and writer prose stay out.
- Diagnostic delivery is non-vetoing. Never use sink success as application
  authority or branch application behavior on whether evidence was retained.
- No secrets, raw prompts, model output, or tool arguments — events are
  sanitized structurally, not content-inspected. Payload strings are redacted
  unless their key is in the narrow diagnostic metadata/identity vocabulary;
  prefer numbers, booleans, enums, counts, and correlation IDs.
- High-frequency per-item events (per chunk, per frame) should be gated behind
  an `OBS_VERBOSE` category so they never compete with lifecycle records.
- `EventSink` is operational diagnostic evidence. Product feature tracking and
  analytics are a separate concern; do not encode them as server diagnostics.

## Cleanup

Before handoff or push, remove temporary evidence and release only the resources
owned by this worktree.

1. Delete every temporary source probe, then run the same product-source check
   that pre-push uses:

```bash
node tools/ci/check-debug-probes.mjs
```

   Convert a signal to durable observability only when it will help another
   debugging session; otherwise delete it.
2. `./mf` keeps authentication in memory and leaves nothing to
   remove. If you used the direct `curl` workflow, delete its local cookie jar:

```bash
rm -f auth.cookies
```

3. Stop this worktree's dev stack through its owner. This removes its tmux
   session and prunes its Portless and Tailscale routes without touching another
   lane:

```bash
pnpm dev:stop
```

Do not manually kill shared Portless or reset Tailscale. Searchable JSONL is
ignored, bounded, and useful after a restart, so routine debugging does not need
to delete `logs/events/`.

Do not drop the worktree database for routine debugging. If the database was
created only for a disposable probe and its state is no longer useful, remove it
through the guarded owner command:

```bash
pnpm dev:db:drop -- --yes
```

After a PR merges or a lane is abandoned, clean the linked worktree, database,
dev session, branch, and work item together. Run this from a checkout you are
not removing and inspect the plan before confirming it:

```bash
pnpm dev:prune-worktrees -- --target <work-id|path|branch|pr> --dry-run
pnpm dev:prune-worktrees -- --target <work-id|path|branch|pr>
```

[mf-claims]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md
