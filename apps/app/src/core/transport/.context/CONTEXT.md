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

## Access scope and 4409

The server names a room's scope in Hocuspocus's authenticated message on every
(re)connect. The transport publishes only what the server names through
`subscribeAccess` (the last named scope on subscribe, nothing before the
first), and `DocumentSession` carries it as `snapshot.access`: `null` until
the server names one, then the last named scope, kept across drops and
transport restarts. An unnamed room is writable (local-first). Access is not a
connection state: a read-only room that drops offline stays read-only.

`null` is what lets a named `edit` count. The Editor host's `readOnly` comes
from its Works catalog, which can predate the room's first connect (a tab
that loaded while the Work was archived and whose room connected after the
unarchive). The host's `RoomScopeCatalogCheck`
(`features/project/context/ContextDocumentHost.tsx`) watches each named
scope, and each activation, against its `readOnly` and refreshes its Works
catalog when they disagree. Its own changes to `readOnly` never ask, so the
tab that archives fetches nothing extra.

A 4409 `access-changed` close (a Work archived, unarchived, deleted or
restored) is not terminal. The transport freezes the room (`read`) and lets
Hocuspocus reconnect with the same Y.Doc; the new authenticated scope then
switches the mounted editor in place. The one exception is a close that lands
while local updates are still unacknowledged: the server refused them, and a
reconnect's SyncStep2 would replay them from the Y.Doc. The transport then
resets with reason `access-changed` instead of reconnecting, and
`DocumentSession.refusedLocalEdits()` forbids `restartTransport` for that
session. A branch (draft review) room rebuilds through
`rebuildBranchRoom`, which starts a fresh session from the server's state. A
live room (scratch) goes through the registry's `dropRefusedRoom`, which
revokes each lease's access: the session is torn down and its IndexedDB copy,
which still holds the refused edits, is cleared. Editor hosts unbind at once
(`useRefusedEditsReopen`) and reopen when the drop settles, so the editor
loads the server's state. A drop that fails leaves the refused session bound
read-only rather than reopening again.

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
account composition. Browser/document targets and randomness are injected;
clocks and timers use late-bound globals. Its listeners last until unmount.
Connections receive the port through their factories, including room restarts.

Online, focus, visible visibility changes, pageshow, and connection success
queue `retry-now`. A 50 ms burst window coalesces signals; each subscriber gets
0–300 ms jitter and at least two seconds between retries. Cooldown signals
schedule one deferred hint. Success reports are transition-based and exclude
the successful source. Offline cancels pending retries, resets the cooldown,
and immediately emits `suspect-offline`. Retry hints restart aggressive backoff,
so repeated wakes against a down server cost at most one attempt per cooldown.

Sockets leave healthy connections alone and fence terminal/destroyed owners.
Offline takes the normal close path without awaiting a native handshake;
`disconnect()` instead disables reconnection. Hocuspocus 4.3 has two retry races:
native open clears the cancellation handle before the first frame settles the
attempt, and post-settlement close schedules a delayed reconnect that can
replace a still-CONNECTING hinted socket. The room adapter retains cancellation
until settlement and owns/fences the delayed close timer. Superseded attempts
settle and cancel before replacement; library queues and acknowledgements stay
intact. Thread success requires the server's `connected` frame.

The resource replica keeps its 30-second interval for pending HTTP work without
new hints. Working-set pagehide/hidden-visibility flushes are persistence signals;
its preference owner binds recovery only for the committed account epoch.
Local document peers and session wakeup keep their content-recovery listeners,
independent of network jitter, cooldowns, or unrelated connection successes.
