# domains/observability — EventSink

Structured observability behind a single required port. Domains that need
runtime diagnostics receive an `EventSink` through DI and emit JSON-natural
records; adapters decide where safe records go.

## What it owns

- **`EventRecord` vocabulary re-export** — the JSON-natural record and stream
  correlation types are canonical in `@meridian/contracts/observability`; the
  server port re-exports them so domain imports stay anchored on the port.
- **`EventSink`** — `emit` / `emitBatch` / `flush`.
- **`EventQuery`** — filtered newest-first recent history and live subscriptions. `excludeName` (exact event-name exclusion) is applied **before** the result `limit`, so a high-volume excluded class (e.g. verbose `stream.chunk`) cannot crowd lifecycle records out of a bounded query. Consumers rely on this to keep polling independent of verbose capture.
- **`emitEvent`** — timestamping helper for non-critical diagnostics.
- **Safe-event helpers** — id stamping, key-pattern redaction, secret stripping,
  bounded envelopes, detachment, and freezing before records leave process memory.
- **`DeferredEventSink`** — process bootstrap sink that buffers startup/crash
  events until production composition binds the real sink.
- **`LocalEventSink`** — local/prod-default adapter: always writes structured
  JSON to stdout and mirrors to `LOG_DIR/YYYY-MM-DD.jsonl` when `LOG_DIR` is set.
  Its 5,000-event pending queue drops oldest under mirror backpressure and emits
  an `observability.sink.dropped` summary after the mirror resumes.
  When JSONL mirroring is enabled, the factory retains 14 daily files by default;
  override with `LOG_RETENTION_DAYS`.
- **`InMemoryEventSink`** / **`NoopEventSink`** — tests and disabled paths.
- **`RecentEventsBuffer`** — dev/test-only 5,000-record ring of safe snapshots behind
  `EventQuery`; `TeeEventSink` composes it with the local sink.

## Wiring

`lib/observability.ts` owns the process-scoped deferred sink. Startup plugins,
request observability, crash policy, and app composition all use the same sink;
`lib/app.ts` binds the env-selected concrete sink once the app singleton starts.

`lib/event-sink-factory.ts` reads `EVENT_PROVIDER` (`local` → stdout + optional
JSONL, `none`/`noop` → no-op). When `LOG_DIR` is set, `LOG_RETENTION_DAYS`
controls local JSONL retention and must be a positive integer; pruning runs when
the sink rolls to a new UTC daily file. External provider policy is deliberately
not wired into production composition yet; inject another `EventSink` later
without changing route or domain code.

With the local provider, `NODE_ENV=development|test` also registers the recent
buffer on `AppServices.eventQuery`. Authenticated `/api/debug/events` and
`/api/debug/events/stream` routes expose filtered history and live-only SSE;
both are absent in every other environment and for disabled sink providers.

There is no ambient fallback in domain code: if a service emits diagnostics, its
constructor/deps require an `EventSink` so disabled observability is an explicit
adapter choice.

LLM-facing local monitors should read the structured `EventRecord` JSONL stream
or an adapter over it. Do not build dashboards by scraping arbitrary console text.

## Safety model

The process-scoped `DeferredEventSink` is the single `safe-event.ts` boundary:
it sanitizes, detaches, and freezes each record synchronously before buffering or
delegating it. The tee, local sink, recent ring, queries, and listeners all receive
that same immutable snapshot, so fan-out does not repeat traversal or share caller-owned aliases.
Call sites should still emit allowlisted metadata and correlation ids rather than
raw prompts, model text, tool arguments/results, uploaded bytes, cookies, or
headers.

## Related

- `domains/storage/` — same port + adapter layout
- Provider swap / OTel posture: [KB decision (OTel deferred)][otel-deferred]

[otel-deferred]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/observability-event-records.md
