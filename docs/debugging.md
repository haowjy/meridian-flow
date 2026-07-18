# Debugging

Use temporary console probes when they help you understand a live bug quickly.
Keep them disposable: delete them before pushing, or convert useful signals into
durable observability through the server `EventSink`.

## Temporary Probes

Use this exact shape:

```ts
// TEMP-DEBUG: remove before push
console.log("[temp-debug:runtime.turn]", { threadId, turnId, state });
```

Rules:

- Put `// TEMP-DEBUG: remove before push` immediately above the console line.
- Prefix the message with `[temp-debug:<area>]`.
- Log one compact metadata object.
- Pre-push blocks `TEMP-DEBUG`, `[temp-debug:...]`, `console.log(`, and
  `console.debug(` in product source, even when the console call is unmarked.
- Do not log secrets, cookies, raw prompts, raw model output, uploaded content,
  tool arguments, or tool results.
- Remove the probe before pushing, or convert it into durable observability.

## Durable Logs

If the signal would help another agent tomorrow, use structured observability
instead of `console.log`.

- Server diagnostics go through `EventSink` / `emitEvent`.
- Stdout is authoritative and lands interleaved in `logs/portless.log` during
  local dev. `LOG_DIR` adds a best-effort daily JSONL mirror at
  `logs/events/YYYY-MM-DD.jsonl`; files are day-pruned, not an audit log.
- The JSONL writer holds at most 5,000 pending events. Filesystem backpressure
  drops oldest first; the next successful write prepends an
  `observability.sink.dropped` record with the loss count.
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

Authenticated local development/test servers with the `local` event provider
retain 5,000 sanitized records in memory. Other environments and disabled
providers return 404; there is no runtime override.

For direct `curl` access, bootstrap through the app and retarget the host-only
development session cookie to the paired server origin:

```bash
APP_URL=https://<lane>.app.meridian.localhost
SERVER_URL=https://<lane>.server.meridian.localhost
COOKIE_JAR=auth.cookies
curl -sS -c "$COOKIE_JAR" "$APP_URL/api/auth/dev-login" >/dev/null
sed -i 's/app\.meridian\.localhost/server.meridian.localhost/' "$COOKIE_JAR"
```

`GET /api/debug/events` returns newest first. Filters are `source` (exact),
`name` (prefix), `level` (severity floor), `sinceEventId` (exclusive),
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

## Cleanup

Find the same product-source patterns that pre-push blocks:

```bash
node tools/ci/check-debug-probes.mjs
```

Pre-push runs `node tools/ci/check-debug-probes.mjs` and blocks temporary probes
in product source. The fix is to delete the probe or convert it to durable
observability.
