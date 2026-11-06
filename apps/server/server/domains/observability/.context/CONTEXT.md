# domains/observability — EventSink

The event model is in the [event record][records] and [bounded
consumption][consumption] decisions.

## Contract

Domain services receive an explicit `EventSink`; there is no ambient fallback.

The process sink carries active HTTP/WebSocket trace scope. Request and domain
joins are explicit at emit sites; detached work retains its scope, while shared
Yjs persistence creates a new trace and emits its document/draft joins.

[records]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/observability/observability-event-records.md
[consumption]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/observability/observability-consumption-seam.md
