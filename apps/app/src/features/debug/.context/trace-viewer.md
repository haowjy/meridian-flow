# Streams

The **Streams** pop-out inspects live transport events while the editor remains
usable. `DebugPopout` portals into a child window that shares the opener's
JavaScript context. Capture therefore remains in the main page; closing the
window does not stop it. Browser operations must use the child document so
focus, clipboard activation, and downloads stay in that window.

## Trace store

`trace/trace-store.ts` owns a 2,000-entry `EventRecord` ring. Producers append
the shared contracts envelope through `appendTraceEvent` and report tap failures
through `noteTapError`; they do not define viewer-specific records.

The store has two subscription contracts:

- `subscribeToTraceStore` coalesces render notifications once per JavaScript
  turn.
- `subscribeToTraceEvents` publishes every append synchronously for
  `waitForEvent`.

Captured events are never coalesced. Reentrant appends are queued in order, and
listener failures cannot escape into the observed transport. At capacity, the
ring evicts the oldest record and increments its drop counter.

In debug-enabled builds, `window.__meridianTrace` exposes metadata-only queries,
statistics, clearing, and next-event waits. Return structured clones so
automation cannot mutate retained records.

Pausing freezes the current projection while capture and ring eviction continue.
Filters and JSONL exports operate on either that frozen projection or the live
one, never on a second store.

## Producers

Client taps attach at the canonical socket seams: `TappedWebSocket` for final
Yjs binary frames and `SocketLifecycleController` for thread lifecycle and final
strings. `installTraceCapture()` registers both taps and the agent API before a
subtree can create either socket. The runtime debug toggle controls the viewer,
not capture. Fast Refresh must preserve observer sequences and Yjs room
attribution through `import.meta.hot.data`. The
[transport context](../../../core/transport/.context/CONTEXT.md) owns the wire
vocabulary and cancellation boundary.

Thread records retain only an allowlisted message class, thread ID, sequence,
AG-UI event type, direction, and UTF-8 byte size. They never copy user, agent,
or tool content, nested catch-up events, socket URLs, or native close-reason
text. Yjs close records map standard codes to a fixed reason vocabulary and
leave unknown codes numeric.

The optional **Server feed** uses `/api/debug/events/stream`. Native
`EventSource` owns reconnection; disabling the feed closes it. Server events use
the same ring, filters, automation API, and exports as client events.

The feed can only show events emitted by server domains; collab success paths do
not yet emit structured events. Deferred row grouping lives in [FUTURE](FUTURE).

Gateway model requests stay outside the trace ring. Inspect them in
[LLM Calls](llm-calls.md).
