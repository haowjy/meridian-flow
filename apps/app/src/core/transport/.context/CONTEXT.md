# Client transport seams

This page records the transport contracts consumed by document sessions and
debug observers. Transport owns wire evidence and lifecycle, not editor policy
or debug-event interpretation.

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
draft sessions; it does not evict sessions or block attachments.

The client declares its schema as the sole WebSocket subprotocol on each Yjs
socket. `CollabSchemaWebSocket` formats the current version through
`@meridian/prosemirror-schema`; the Yjs URL carries no schema parameter. The
subclass wraps `TappedWebSocket` in debug builds and the native `WebSocket` in
production so observation does not create a second transport path.

## Outbox and acknowledgement edges

The outbox is the session layer's evidence that the writer has typing the
server has not acknowledged. Draft review counts it as changes at the shown
generation, and `DraftWriterHandoff` carries it into the next generation, so
it must be visible to every observer before anything can act on its absence.

- **Store, then send.** `handleDocumentUpdate` registers on the `Y.Doc` before
  `HocuspocusProvider` is constructed. Yjs (lib0 `ObservableV2`) runs update
  listeners in registration order, so local bytes are stored before the
  provider's own listener sends them and the native send tracker publishes
  acknowledgement `false`. The provider constructor does not mutate the
  document, and the explicit websocket keeps it from attaching on its own, so
  the early registration sees no constructor updates.
- **Edges only.** The transport publishes its own acknowledgement observation
  only when the outbox goes from empty to pending. An acknowledgement clears
  the outbox before notifying. `DocumentSession.recomputeStatus` deduplicates
  on status, server acknowledgement and outbox presence, so a typing burst
  yields one pending snapshot and one clearing snapshot. A per-update emission
  re-rendered every subscribed editor on each keystroke.

The ordering is a live transport contract, not a test-double detail. A witness
for it must exercise `test-support/DocumentSocketHarness`, as the transport
acknowledgement and remote whole-discard probes do.

## Draft rooms: the handshake upload goes first

A draft room's server appends each Update on top of the bytes it
already holds and closes `4207 draft-prefix-missing` when an Update depends
on bytes it lacks. Hocuspocus's own order would produce exactly that on every
reconnect: the offline queue flushes on the socket's first inbound frame, and
keys typed during the handshake go out at once, both before the client's
SyncStep2 (its reply to the server's SyncStep1).

So on `draft:` rooms only, `RoomScopedHocuspocusWebsocket.send` holds every
Sync Update offered on an open socket until that socket's SyncStep2 has been
written, then releases the held frames in order through the same `send`. Wire
order on every draft connection is `step1, step2, [released updates],
[new updates]`.

- **The SyncStep2 is the causal prefix.** It is the whole Y.Doc diffed against
  the server's state vector, so it carries everything the server lacks,
  including bytes replayed into the Y.Doc before the transport existed. The
  released frames are echoes the server contains.
- **Counted when written, once.** A held frame reaches `noteFrameSent` only on
  release; the tracker's handshake flag is set by the real SyncStep2.
- **A socket that closes first writes nothing it held.** `onOpen` and
  `onClose` drop the held frames; the next socket's SyncStep2 carries their
  bytes. Frames offered while the socket is not open keep the base class
  queue.
- **No timeout.** A server that never sends SyncStep1 leaves the frames held
  and the room unacknowledged; nothing releases them unsafely.
- **Typing never waits.** The Y.Doc, the editor and the outbox have the key
  at once; only transmission is deferred, by one handshake round trip.
- **Live rooms are unchanged.** Their server marks the SyncStep2 for offline
  collision reconciliation, so moving queued bytes into it would change what
  is reconciled; a live socket writes in the provider's order.

`4207` is not a refusal. It never counts toward the three-`1008` refusal bound
(`MAX_DRAFT_UPDATE_REFUSALS` in `hocuspocus-document-transport.ts`; see the
editor's `.context/CONTEXT.md`),
keeps the outbox, and reconnects after the provider's delay like any drop.
After handshake-first it means a server that lost committed rows or a peer that
skips the handshake, and the next connection's SyncStep2 repairs it. Decision:
[drafts without locks](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/drafts-without-locks.md).

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
session. A draft (review) room rebuilds through
`rebuildDraftRoom`, which starts a fresh session from the server's state. A
live room (scratch) goes through the registry's `dropRefusedRoom`, which
revokes each lease's access: the session is torn down and its IndexedDB copy,
which still holds the refused edits, is cleared. Editor hosts unbind at once
(`useRefusedEditsReopen`) and reopen when the drop settles, so the editor
loads the server's state. A drop that fails leaves the refused session bound
read-only rather than reopening again.

## 4208: the document was removed

A `4208 document-deleted` close is terminal for live and draft rooms alike:
the transport freezes the room (`read`), resets with disposition `removed`
and never reconnects on its own. Nothing rebuilds, replays or drops it, and a
draft review keeps the terminal session painted. The registry reports each
live room's close once (`observeRemovedRooms`) and the account lifetime asks
the record cache again; the availability removal closes the tab and says who
removed the document. Only a lookup after the close that proves the document
present restarts the room, once per close: the lifetime's
`restartRemovedRoom`, or an explicit open's bind (`restartUnavailableRoom`). See
`features/project/context/.context/resource-catalog-and-editor-lifecycle.md`.

## Stateless document messages

`HocuspocusDocumentTransport` parses the extensible stateless payload once with
the contracts parser, ignores unknown message types, and exposes typed,
per-message subscriptions. Live `DocumentSession`s subscribe to
`change_event`; draft sessions deliberately do not.

## Dev-only wire observation

The two client socket types use their canonical transport seams.
`TappedWebSocket` observes each room-scoped Hocuspocus socket's final binary
frames.
`@meridian/thread-client` owns `SocketLifecycleController` and the thread socket
client. The app's `TransportProvider` injects its wire-tap adapter to observe
lifecycle and final string frames. Both are active only behind the build-time debug gate;
default production builds retain native WebSockets without capture, while the
explicit `VITE_DEBUG_OVERLAY=1` build override includes the debug observers.
Neither seam parses or retains frames, and observer failures never escape into
product transport.
`socketEpoch` distinguishes reconnects while each registered tap owns
page-lifetime sequencing.

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

Thread protocol, cursor and deadline contracts belong to the
[shared thread client](../../../../../../packages/thread-client/.context/CONTEXT.md).
The app supplies browser WebSocket creation, URL, API error conversion, HTTP
cancellation, connectivity hints and debug-gated observation through
`TransportProvider`. App `onGap` consumers refetch snapshots; a gap burst
coalesces into one app resync rather than one per gap.

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
