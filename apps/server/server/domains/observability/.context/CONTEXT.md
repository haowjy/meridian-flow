# domains/observability — EventSink

Structured observability behind a single required port. Domains that need
runtime diagnostics receive an `EventSink` through DI and emit JSON-natural
records; adapters decide where safe records go.

## What it owns

- **`EventRecord` vocabulary re-export** — the JSON-natural record and stream
  correlation types are canonical in `@meridian/contracts/observability`; the
  server port re-exports them so domain imports stay anchored on the port.
- **`EventSink`** — `emit` / `emitBatch` / `flush`.
- **`EventQuery`** — filtered newest-first recent history and live subscriptions.
  Exact `eventId` lookup is supported; results report evicted records and bytes.
  `excludeName` is applied **before** the result `limit`.
- **`emitEvent`** — timestamping helper for non-critical diagnostics.
- **Safe-event helpers** — id stamping, default-denied exception/query fields,
  allowlisted error envelopes, secret stripping, bounded traversal/envelopes,
  detachment, and freezing before records leave process memory.
- **`DeferredEventSink`** — process bootstrap sink that buffers startup/crash
  events until production composition binds the real sink.
- **`LocalEventSink`** — local/prod-default adapter: always writes structured
  JSON to stdout and mirrors to 8 MiB JSONL segments when `LOG_DIR` is set. Its
  5,000-event / 16 MiB pending queue drops oldest under backpressure and reports
  lost records and bytes. Segments retain for 14 days and at most 128 MiB per
  worktree by default (`LOG_RETENTION_DAYS`, `LOG_MAX_BYTES`); a directory lock
  serializes allocation, append, and pruning across overlapping server generations.
- **`InMemoryEventSink`** / **`NoopEventSink`** — tests and disabled paths.
- **`RecentEventsBuffer`** — dev/test-only 5,000-record / 16 MiB ring of safe
  snapshots behind `EventQuery`; `TeeEventSink` composes it with the local sink.
- **Causal scope** — the process sink enriches active HTTP and WebSocket work
  with a trace. Request and domain joins stay explicit at emit sites. The active
  trace wins event conflicts; a bounded diagnostic reports mismatches without
  vetoing the operation. Detached work retains its scope; shared Yjs persistence
  mints a new trace and emits document or branch joins explicitly.

## Wiring

`lib/observability.ts` owns the process-scoped deferred sink. Startup plugins,
request observability, crash policy, and app composition all use the same sink;
`lib/app.ts` binds the env-selected concrete sink once the app singleton starts.
The process facade and fan-out adapters swallow diagnostic adapter failures:
evidence loss is observable where possible, but can never veto application work.

`lib/event-sink-factory.ts` reads `EVENT_PROVIDER` (`local` → stdout + optional
JSONL, `none`/`noop` → no-op). When `LOG_DIR` is set, `LOG_RETENTION_DAYS` and
`LOG_MAX_BYTES` control local JSONL retention and must be positive integers;
pruning runs when the sink rolls segments. External provider policy is deliberately
not wired into production composition yet; inject another `EventSink` later
without changing route or domain code.

With the local provider, `NODE_ENV=development|test` also registers the recent
buffer on `AppServices.eventQuery`. Authenticated `/api/debug/events` and
`/api/debug/events/stream` routes expose filtered history and live-only SSE;
both are absent in every other environment and for disabled sink providers.

There is no ambient fallback in domain code: if a service emits diagnostics, its
constructor/deps require an `EventSink` so disabled observability is an explicit
adapter choice.

LLM-facing local monitors should use `pnpm debug:events` for bounded authenticated
queries, or read the structured JSONL stream for post-restart forensics. Do not
build dashboards by scraping arbitrary console text.

## Safety model

The process-scoped `DeferredEventSink` is the single `safe-event.ts` boundary:
it sanitizes, detaches, and freezes each record synchronously before buffering or
delegating it. The tee, local sink, recent ring, queries, and listeners all receive
that same immutable snapshot, so fan-out does not repeat traversal or share caller-owned aliases.
Records are capped at 8 KiB; oversized payloads become a deterministic marker
while headers and bounded correlation survive. Error conversion retains only
  known-safe identity/status fields, never arbitrary messages, stacks, causes,
  SQL, or provider text. Payload strings are default-denied unless their key is
  in the owner-reviewed metadata/identity vocabulary. Sanitizer traversal and secret scanning are bounded before
the serialized ceiling is calculated. Call sites should still emit allowlisted metadata and correlation ids rather than
raw prompts, model text, tool arguments/results, uploaded bytes, cookies, or
headers.

`EventRecord` / `EventSink` are operational diagnostics, not product feature
tracking or analytics. Product events need a separate future seam.

## Related

- `domains/storage/` — same port + adapter layout
- Provider swap / OTel posture: [KB decision (OTel deferred)][otel-deferred]

[otel-deferred]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/observability-event-records.md
