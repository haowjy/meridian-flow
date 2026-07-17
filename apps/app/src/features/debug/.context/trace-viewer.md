# Debug trace viewer

The pill's **Streams** action opens `TraceViewer` in a separate browser window
and portals the React tree into it. The popup shares the opener's JavaScript
context, so capture state stays in the main page and remains live while the
editor is used; closing the popup never stops capture. The popup clones the
opener's active style/link nodes and document attributes. Popup controls use
owner-document browser primitives so keyboard focus, clipboard activation, and
downloads stay in the child window rather than leaking back to the opener.

## Capture store and automation boundary

Its plain-TypeScript store (`trace/trace-store.ts`) owns a 2,000-entry
`EventRecord` ring and exposes the producer boundary `appendTraceEvent` /
`noteTapError`; producers append the shared contracts envelope, never a
viewer-specific record. In debug-enabled builds, `window.__meridianTrace`
provides agents with metadata-only queries, stats, clearing, and next-event waits
without coupling automation to the viewer DOM. Query and wait results are
structured clones, so automation cannot mutate records retained by the ring.
The ring drops the oldest record at capacity and counts ring drops and tap
errors. Two subscriber channels serve it: `subscribeToTraceStore` coalesces
notifications per JavaScript turn so a burst renders once, while
`subscribeToTraceEvents` fires synchronously per append and backs `waitForEvent`.
Reentrant appends during event dispatch are queued and drained in order, and
throwing event listeners are swallowed, so debug consumers cannot disrupt the
observed transport. Captured records are never coalesced — only store
notifications are. The viewer provides composable stream, message-class,
direction, and correlation filters; frozen live-tail inspection; record detail;
and filtered JSONL copy, download, and accessibility-tree output. Freeze
snapshots the current projection while capture and eviction continue. Future
lenses project over this same store rather than adding data paths.

## Client transport capture

The dev-only client taps use each socket's canonical core seam:
`TappedWebSocket` for final Yjs binary frames and `SocketLifecycleController`
for thread lifecycle and final strings. `trace/yjs-wire-tap.ts` maps binary
collab frames; `trace/thread-wire-tap.ts` maps thread JSON strings into
allowlisted message class, thread id, sequence, AG-UI event type, and size only.
It never copies agent/user/tool content, nested catchup events, or error text.
The [client transport seams](../../../core/transport/.context/CONTEXT.md)
define the thread wire vocabulary and cancellation boundary.
The authenticated composition root synchronously installs both taps before
rendering any subtree that can create either socket; the visual overlay remains
lazy. One `installTraceCapture()` call owns both registrations, the agent API,
and the Yjs/thread HMR state handoff. Capture is always on for the page lifetime
and the runtime toggle gates only the viewer. Vite hot data preserves both
observer sequences and Yjs room attribution when Fast Refresh replaces the taps.

`stream.bytes` on thread records is the UTF-8 encoded frame size, not JavaScript
string length. Lifecycle records never retain socket URLs or native close-reason
text, and use their `socket.open` or `socket.close` name as the message class so
the viewer and agent API share one primary filter. Yjs closes map standard WebSocket codes to a fixed reason vocabulary;
unknown codes remain numeric-only. Thread and Yjs closes retain `socketEpoch`,
numeric `code`, and `wasClean`.

## Scope and deferred work

Server-side collab operations still emit zero success-path structured events —
the server half (S4: correlation receipts, SSE feed, and durability columns) is
[#239](https://github.com/haowjy/meridian-flow/issues/239) in cluster
[#235](https://github.com/haowjy/meridian-flow/issues/235). The current viewer
is the client wire core, not the final multi-source surface: S6 adds the LLM
calls lens only after S4's feed and S5's gateway events exist. Burst grouping
is intentionally deferred beside the S4 viewer merge; see [FUTURE](FUTURE).
