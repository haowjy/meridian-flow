# Debugging

Start from your symptom in [Strategies](#strategies), or scan the
[Toolbox](#toolbox) for what each surface gives you. Detail sections follow;
[Adding Observability](#adding-observability) covers emitting new signals.

## Toolbox

| Tool | Reach for it when | Detail |
| --- | --- | --- |
| Temporary console probes | You need a one-off signal from a live bug, now | [Temporary Probes](#temporary-probes) |
| `EventSink` / `emitEvent` | The signal would help another agent tomorrow | [Durable Logs](#durable-logs) |
| `./mf` | An agent needs to drive or inspect a thread, seed data, or script the mock model without a browser | [Drive the App from the CLI](#drive-the-app-from-the-cli) |
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
- **Something is slow or chatty.** LLM Calls panel first (latency, retries,
  token counts per call). For per-chunk granularity, opt into
  `OBS_VERBOSE=gateway.chunks` (dev/test only) and re-run.
- **An LLM is debugging.** Reproduce with `./mf thread send` (pair
  `MODEL_PROVIDER=mock` with `--mock` for deterministic tool paths), read the
  result with `./mf thread view`, then `./mf log --thread <id>` or
  `./mf log --trace <id>`. Add `--full` only when compact metadata is
  insufficient. Use `./mf thread context` when the question is what the model
  received rather than what the runtime did.
- **It broke and the server restarted.** The in-memory ring is gone; fall back
  to the JSONL mirror with `jq`, remembering it is best-effort and bounded.
- **Polling from a script or agent.** Use `sinceEventId` cursors — event IDs
  are stable at emit time, so incremental polls never re-read history.

## Drive the App from the CLI

`./mf` (repo root) is a thin wrapper over this worktree's own API: every command
maps to an existing HTTP route or thread-socket message, authenticated exactly
like the browser through dev login. Run `./mf` for the command tree with the
route each command wraps, and `./mf <noun> <verb> --help` for flags and examples.
Use it instead of the browser for anything that is not visual.

```bash
./mf seed tools/dev/cli/fixtures/basic.json        # docs + thread + an opening message
./mf thread send <id> "Tighten the opening" --ref manuscript://mf-chapter-1.md
./mf thread send <id> "go" --mock @tools/dev/cli/fixtures/mock-write.json --json | tail -1
./mf thread view <id>                              # transcript with tool calls
./mf thread tail <id> --until-idle                 # follow a run started elsewhere
./mf doc read manuscript://mf-scene.md
./mf api GET /api/threads/<id>/skills              # any route without a dedicated command
```

Contract:

- Compact text by default; `--json` prints exactly one object, or NDJSON for
  streams (`send`, `tail`, `events`, `log --follow`) whose last `send` line is
  the terminal `{type: "result" | "error", status, finalText, ...}` envelope.
  `--fields a,b` trims JSON. Errors go to stderr (`{error, code, hint}` under
  `--json`).
- `send` waits by default and its exit code is the outcome: 0 complete,
  1 failed, 5 cancelled, 8 waiting on an interrupt (answer with
  `./mf thread respond`), 124 timeout. 2 is usage, 3 not found, 4 the stack is
  not running or dev login failed. Every wait is bounded by `--timeout`.
- `<thread>` accepts a full id, a unique prefix, a `cN` ref, or an app URL.
- `MF_SERVER_URL` plus `MF_COOKIE` (or `MF_APP_URL` for dev login) target a
  stack other than this worktree's Portless routes.

Scripting the model: with `MODEL_PROVIDER=mock` (or no provider keys) the
in-process mock model accepts queued replies through the dev-only
`/api/debug/mock-model/script` route. Each step answers one model call with
`text`, `toolCalls` (`[{name, args}]`), an `error` (`{status, message}`), and
an optional `delayMs`. `send --mock` scopes the script to that message, so
concurrent threads cannot consume it; `./mf mock script|list|clear` manage the
queue directly. Unscripted calls keep the mock's canned behavior.

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
- The dev Vite and Nitro watchers exclude the repository `logs/` tree. Log
  writes must not reload either process; a reload during a long-running turn is
  a bug, not expected dev behavior.
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
not a claim about a provider SDK's private wire encoding. Capture is enabled in
local development, lives only in process memory, and is bounded to 200 records,
2 MiB per request, and 16 MiB total. Oversized requests keep metadata and a
digest but omit their body. A server restart clears the ring. Request content
never enters `EventSink`, the event journal, thread snapshots, or JSONL logs.
Staging and production cannot enable this capture. The Readable lens contains
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

Authenticated local development/test servers with the `local` event provider
retain up to 5,000 sanitized records or 16 MiB in memory. Other environments
and disabled providers return 404; there is no runtime override.

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
