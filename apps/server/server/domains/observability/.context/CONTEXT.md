# domains/observability — EventSink

Structured observability behind a single required port. Domains that need
runtime diagnostics receive an `EventSink` through DI and emit JSON-natural
records; adapters decide where those records go.

## What it owns

- **`EventRecord`** — minimal JSON-natural record: `timestamp`, `level`,
  `source`, `name`, `payload`.
- **`EventSink`** — `emit` / `emitBatch` / `flush`.
- **`emitEvent`** — fire-and-log helper for non-critical diagnostics.
- **`JsonlEventSink`** — local/dev adapter writing `LOG_DIR/YYYY-MM-DD.jsonl`.
- **`InMemoryEventSink`** / **`NoopEventSink`** — tests and disabled paths.

## Wiring

`lib/event-sink-factory.ts` owns `createEventSinkFromEnv()` and reads
`EVENT_PROVIDER` (`local` → JSONL, `postgres` → currently fails closed until a
Postgres sink lands, `none`/test paths use explicit no-op or in-memory sinks).
`lib/app.ts` creates the production sink and passes it into
`createProductionAppPorts()`; `composeAppServices()` then requires it for the
hub, orchestrator, turn runner, core/skill tool wiring, uploads, figures, and
other diagnostics-producing services.

There is no ambient fallback in domain code: if a service emits diagnostics, its
constructor/deps require an `EventSink` so disabled observability is an explicit
adapter choice.

## Related

- KB decision D15 (`observability-event-sink.md`) — full Event model and Postgres sink deferred
- `domains/storage/` — same port + adapter layout
