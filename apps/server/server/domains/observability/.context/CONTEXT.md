# domains/observability — EventSink

Structured observability behind a single required port. Domains that need
runtime diagnostics receive an `EventSink` through DI and emit JSON-natural
records; adapters decide where safe records go.

## What it owns

- **`EventRecord`** — safe structured record: `eventId`, `timestamp`, `level`,
  `source`, `name`, `sensitivity`, optional correlation envelope, and sanitized
  `payload`.
- **`EventSink`** — `emit` / `emitBatch` / `flush`.
- **`emitEvent`** — timestamping helper for non-critical diagnostics.
- **Safe-event helpers** — id stamping, key-pattern redaction, secret stripping,
  and truncation before records leave process memory.
- **`DeferredEventSink`** — process bootstrap sink that buffers startup/crash
  events until production composition binds the real sink.
- **`LocalEventSink`** — local/prod-default adapter: always writes structured
  JSON to stdout and mirrors to `LOG_DIR/YYYY-MM-DD.jsonl` when `LOG_DIR` is set.
  When JSONL mirroring is enabled, the factory retains 14 daily files by default;
  override with `LOG_RETENTION_DAYS`.
- **`InMemoryEventSink`** / **`NoopEventSink`** — tests and disabled paths.

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

There is no ambient fallback in domain code: if a service emits diagnostics, its
constructor/deps require an `EventSink` so disabled observability is an explicit
adapter choice.

LLM-facing local monitors should read the structured `EventRecord` JSONL stream
or an adapter over it. Do not build dashboards by scraping arbitrary console text.

## Safety model

Adapters sanitize with `safe-event.ts` before records leave process memory.
Call sites should still emit allowlisted metadata and correlation ids rather than
raw prompts, model text, tool arguments/results, uploaded bytes, cookies, or
headers.

## Related

- `domains/storage/` — same port + adapter layout
