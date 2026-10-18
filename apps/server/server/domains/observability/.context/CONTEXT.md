# domains/observability — EventSink

This context covers the server observability port and its process adapters. The
port is required by diagnostic producers, while adapter failure must never veto
application work.

## Contract

`EventRecord` and correlation types are canonical in
`@meridian/contracts/observability`; this domain re-exports them with
`EventSink` (`emit`, `emitBatch`, `flush`) and `EventQuery` (newest-first
history, exact-id lookup, and live subscriptions). `excludeName` is applied
before `limit`, and query results report evictions and bytes.

`emitEvent` supplies timestamps for non-critical diagnostics. Domain services
receive an explicit `EventSink`; there is no ambient fallback. Operational
events are not product analytics.

## Safety and scope

`safe-event.ts` is the single boundary: it sanitizes, detaches, bounds, and
freezes records synchronously before buffering or fan-out. Payload strings are
default-denied except for the owner-reviewed metadata/identity vocabulary;
error envelopes retain only known-safe identity and status fields. Records are
bounded at 8 KiB, and callers must not emit prompts, model text, tool
arguments/results, uploaded bytes, cookies, headers, SQL, stacks, or provider
messages.

The process sink carries active HTTP/WebSocket trace scope. Request and domain
joins are explicit at emit sites; detached work retains its scope, while shared
Yjs persistence creates a new trace and emits its document/draft joins.

## Wiring

`lib/observability.ts` owns the process-scoped `DeferredEventSink`; `lib/app.ts`
binds the env-selected adapter once the app singleton starts. The deferred,
fan-out, and process facades swallow adapter failures so evidence loss is
observable where possible but cannot fail a request.

`EVENT_PROVIDER=local` writes structured JSON to stdout and optionally JSONL;
`none`/`noop` selects the no-op adapter. When the debug gate is open outside
production, composition may add the bounded recent-event query and authenticated
debug routes. External providers are injected through `EventSink`, not wired
into domain code.

Local monitors should use the bounded authenticated `./mf log` query or the
structured JSONL stream, never scrape arbitrary console text.

Related: [`domains/storage`](../../storage/) uses the same port/adapter shape;
provider and OTel posture is recorded in the [deferred OTel decision][otel].

[otel]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/observability/observability-event-records.md
