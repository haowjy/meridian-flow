# Streams

`DebugPopout` portals into a child window that shares the opener's JavaScript context.
Capture therefore stays in the main page, and closing the window doesn't stop it.
Browser operations have to use the child document, so focus, clipboard activation and
downloads stay in that window.

## Trace store

`subscribeToTraceStore` coalesces render notifications per JavaScript turn, while
`subscribeToTraceEvents` publishes every append synchronously for `waitForEvent`.
Captured events are never coalesced, reentrant appends queue in order, and listener
failures can't escape into the observed transport.

`window.__meridianTrace` returns structured clones so automation can't mutate retained
records.

Pausing freezes the current projection while capture and ring eviction continue.
Filters and exports use that projection or the live one, never a second store.

## Producers

Taps attach at the canonical socket seams, `TappedWebSocket` and
`SocketLifecycleController`. `installTraceCapture()` registers them and the agent API
before a subtree can create either socket. The runtime debug toggle controls the viewer,
not capture. Fast Refresh has to preserve observer sequences and Yjs room attribution
through `import.meta.hot.data`. The
[transport context](../../../core/transport/.context/CONTEXT.md) owns the wire
vocabulary.

Thread records keep only an allowlisted message class, thread ID, sequence, AG-UI event
type, direction and byte size. They never copy user, agent or tool content, nested
catch-up events, socket URLs or native close-reason text.

The Server feed shows only events server domains emit, and collab success paths emit no
structured events yet.
