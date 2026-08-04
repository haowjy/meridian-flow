# Debugging

Start from your symptom in [Strategies](#strategies), or scan the
[Toolbox](#toolbox) for what each surface gives you. Detail sections follow;
[Adding Observability](#adding-observability) covers emitting new signals.

## Toolbox

| Tool | Reach for it when | Detail |
| --- | --- | --- |
| Temporary console probes | You need a one-off signal from a live bug, now | [Temporary Probes](#temporary-probes) |
| `EventSink` / `emitEvent` | The signal would help another agent tomorrow | [Durable Logs](#durable-logs) |
| `pnpm debug:events` | An agent needs bounded JSON for one known event/trace/domain id | [Consume Server Events](#consume-server-events) |
| `GET /api/debug/events` | Query recent server events by correlation/source/level | [Consume Server Events](#consume-server-events) |
| `GET /api/debug/events/stream` | Live SSE tail while reproducing | [Consume Server Events](#consume-server-events) |
| DebugOverlay → **LLM Calls** | Inspect gateway calls: latency, tokens, outcomes, retries | debug pill in dev builds |
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
- **An LLM is debugging.** Start with
  `pnpm debug:events -- --trace <id>`. Pivot by thread, turn, document, error
  code, or exact event ID. Add `--full` only when compact metadata is insufficient.
- **It broke and the server restarted.** The in-memory ring is gone; fall back
  to the JSONL mirror with `jq`, remembering it is best-effort and bounded.
- **Polling from a script or agent.** Use `sinceEventId` cursors — event IDs
  are stable at emit time, so incremental polls never re-read history.

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
- Model-request diagnostics can use the existing model-request debug capture
  path when that is the right level of detail. Broader prompt and agent-run
  trace capture is not implemented yet; until it exists, use safe metadata in
  `EventSink` events and keep protected content out of ordinary searchable logs.
- Client Yjs and thread-socket diagnostics are captured as metadata-only
  `EventRecord`s in debug-enabled builds. Open **Streams** from the debug pill
  for the live viewer, or use `window.__meridianTrace` for programmatic queries,
  stats, clearing, and next-event waits. API results are detached clones; caller
  mutation cannot alter retained evidence. Enable **Server feed** in Streams for
  process-side records, or use the HTTP surfaces below directly.

## Consume Server Events

For an LLM or script, prefer the repository CLI. It resolves the current
worktree's live Portless routes, performs dev login in memory, and never writes
a cookie jar:

```bash
pnpm debug:events -- --trace <trace-id>
pnpm debug:events -- --thread <thread-id> --level error
pnpm debug:events -- --event <event-id> --full
```

A narrowing pivot is required: `--event`, `--trace`, `--thread`, `--turn`,
`--document`, or `--error-code`. Optional filters are `--source`, `--name`,
`--level`, `--since`, and `--limit`. Compact output omits payloads and caps at
50 events; `--full` includes sanitized records and caps at 200. Output includes
the query and dropped record/byte counts. Requests have a five-second wall-clock
deadline; login and event bodies have 64 KiB and 2 MiB byte ceilings. Failures
exit nonzero with remediation.

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
  sanitized structurally, not content-inspected.
- High-frequency per-item events (per chunk, per frame) should be gated behind
  an `OBS_VERBOSE` category so they never compete with lifecycle records.
- `EventSink` is operational diagnostic evidence. Product feature tracking and
  analytics are a separate concern; do not encode them as server diagnostics.

## Cleanup

Find the same product-source patterns that pre-push blocks:

```bash
node tools/ci/check-debug-probes.mjs
```

`pnpm check` and pre-push run `node tools/ci/check-debug-probes.mjs`. The fix is
to delete a temporary probe or convert a reusable server signal to durable
observability.
