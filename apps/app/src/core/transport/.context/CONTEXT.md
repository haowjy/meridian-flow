# Client transport seams

## Document status

Every `DocumentSessionTransportProvider.subscribeStatus` implementation emits
its current connection state synchronously before the subscription call
returns, then emits every later transition. `DocumentSession` relies on that
initial callback to derive an honest first status; a deferred initial emission
creates a timing-dependent gap between the transport and session snapshots.

Document collaboration sockets are room-scoped rather than multiplexed. A
typed schema refusal is a physical WebSocket close, so a shared socket would
deliver one room's 4406/4407 to every attached provider and reset healthy
rooms. The session registry remains the per-room deduplication owner; the cost
is one physical socket per attached room. The soft-cap warning runs when a live
session is added but compares the registry's total session count, including
branch sessions; it does not evict sessions or block attachments.

The client declares its schema as the sole WebSocket subprotocol on each Yjs
socket. `CollabSchemaWebSocket` formats the current version through
`@meridian/prosemirror-schema`; the Yjs URL carries no schema parameter. The
subclass wraps `TappedWebSocket` in debug builds and the native `WebSocket` in
production so observation does not create a second transport path.

## Stateless document messages

`HocuspocusDocumentTransport` parses the extensible stateless payload once with
the contracts parser, ignores unknown message types, and exposes typed,
per-message subscriptions. Live `DocumentSession`s subscribe to
`change_event`; branch sessions deliberately do not.

## Dev-only wire observation

The two client socket types use their canonical transport seams.
`TappedWebSocket` observes each room-scoped Hocuspocus socket's final binary
frames.
`SocketLifecycleController` observes the thread/agent socket's lifecycle and
final string frames. Both are active only behind the build-time debug gate;
default production builds retain native WebSockets without capture, while the
explicit `VITE_DEBUG_OVERLAY=1` build override includes the debug observers.
Neither seam parses or retains frames, and observer failures never escape into
product transport.
`socketEpoch` distinguishes reconnects while each registered tap owns
page-lifetime sequencing.

Thread close observation runs before the controller's current-socket guard so
controlled closes from teardown, manual reconnect, and ping timeout remain
visible. The guard still fences every product callback, state transition, and
reconnect decision for stale socket generations. Lifecycle observers receive
only the socket epoch, numeric close code, and `wasClean`; URL and raw close
reason text do not cross the core observer contract.

Core owns only the late-bound, transport-specific `YjsWireTap` and
`ThreadWireTap` contracts. The debug feature registers both implementations in
one authenticated-route composition action, before either socket can be
created; runtime overlay enablement controls visibility, not capture. Separate
tap interfaces prevent thread strings from broadening the Yjs byte contract.
`notifyYjsRoomAttached` supplies the local `Y.Doc.clientID` needed to attribute
outgoing deletion-only updates, whose bytes contain the deleted items' creators
but not the deleter.

Provider hooks are not the final-byte seam; use `TappedWebSocket`. Protocol
inspection and `EventRecord` construction belong in the debug feature,
preserving the dependency direction
`features/debug -> core/transport`. Thread inspection follows the same boundary
and must only emit allowlisted classifications and identifiers; no agent, user,
tool, catchup, or error content may enter an `EventRecord`.

The thread socket's client wire vocabulary is `subscribe`, `unsubscribe`,
`resume`, `pong`, and `interrupt.respond`; its server vocabulary is `connected`,
`subscribed`, `event`, `gap`, `error`, and `ping`. Turn cancellation is an HTTP
operation through `cancelTurn`, not a WebSocket message. Keep these names aligned
with `@meridian/contracts/protocol` rather than inferring them from UI actions.

A `gap` means the server could not replay from the client's cursor. Its frame
carries `fromSeq`/`toSeq`; the transport advances the subscription's resume point
to `toSeq` before re-subscribing, so the next read asks for history the server
can serve. The truncated catch-up that follows is skipped by the monotonic seq
guard, and the `onGap` consumers refetch the thread snapshot as the real resync.
A gap burst coalesces into one resync rather than one per gap.

## Shared connectivity hints

`ConnectivityProvider` owns one `ConnectivityHints` instance above authenticated
account and transport composition. The browser, clock, random source, and timer
functions are injected. Browser listeners exist only while the provider is
mounted. Connections receive the port through their existing factories/owners,
including registry room restarts; new connections must subscribe instead of
adding window listeners.

Online, focus, visible visibility changes, pageshow, and a connection's success
queue `retry-now`. A 50 ms burst window coalesces signals; each subscriber gets
0–300 ms jitter and at least two seconds between retries. A signal during the
cooldown schedules one deferred hint instead of losing recovery evidence.
Success reports are transition-based and exclude the successful source.
Offline cancels pending retries, resets the cooldown for the next network
recovery, and immediately emits `suspect-offline`.

Hints do not replace backoff or poll. Document and thread sockets leave healthy
connections alone, fence terminal/destroyed owners, and take their normal close
path immediately on offline, without waiting for a native close handshake.
The room adapter owns reconnect generations: it cancels and fences the delayed
close timer and retains Hocuspocus 4.3's abortable retry cancellation through
native open until the first frame settles the attempt. A new generation settles
the superseded attempt and cancels its retry before replacement. Library
backoff, socket cleanup, message queues, and acknowledgement handling remain
unchanged. Do not call `disconnect()` for browser offline (that disables the
normal reconnect loop). Thread success is reported only on the server's
`connected` frame through the socket lifecycle's canonical state publisher.

The resource replica retains its 30-second retry interval: failed HTTP work can
remain pending without another browser event or socket success. Working-set
pagehide and hidden-visibility flushes remain persistence signals. Local document
peers and session wakeup retain their lifecycle listeners: cross-tab content
recovery is not network recovery and must not inherit retry jitter, cooldowns,
or unrelated server-connection successes.
