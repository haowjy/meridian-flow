# Debug state machines

## Server feed

The debug overlay's event stream from the server (`ServerFeedState` in `trace/server-feed.ts`).

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> connecting: startServerFeed
  connecting --> open: EventSource onopen
  connecting --> error: onerror, or the constructor throws
  open --> error: onerror
  error --> open: EventSource reconnects by itself
  connecting --> idle: stopServerFeed
  open --> idle: stopServerFeed
  error --> idle: stopServerFeed
```

Reconnection belongs to the browser's `EventSource`; this module adds no retry of its own. A
malformed frame is skipped without changing state. Callbacks from a source that has been
replaced are ignored.
