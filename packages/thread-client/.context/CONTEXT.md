# Shared thread client contracts

## Thread socket

`ThreadSocketClient` owns connect, server-`connected` gating, thread subscribe
and resume, sequenced dispatch and deduplication, gap notification before cursor
advancement, reconnect and backoff, catalog subscriptions, and interrupt answers.
Socket generations fence stale product callbacks; close observation precedes
that fence so controlled closes remain visible. Gap consumers recover truncated
history through snapshots. Cancellation uses the injected HTTP operation.

Inject `url`, `webSocketFactory`, `toError`, and `cancelTurn`; optional
`connectivity` supplies recovery hints and success reporting, and optional
`observer` receives final string frames, open, and close. The app's
`TransportProvider` owns browser composition and supplies observation only under
its build-time debug gate. Observer adapters must not throw or affect transport.
`SocketLike` and `SocketClose` are platform-neutral contracts; ready states use
the protocol constants 0 (connecting) and 1 (open). Timers, clocks, and randomness
remain late-bound globals, preserving existing reconnect timing.

## Message documents

Non-editor callers use `buildMessageDoc`: skills, prose and references are inline
children of one paragraph; authored newlines become `hardBreak` nodes, as in the composer.
Its typed construction shape prevents top-level inline nodes. The serializer still
accepts editor JSON so browser schema and editor lifecycle remain app-owned.

`serializeMessageDoc` reads plain JSON, preserving authored spacing and occurrence order.
References spell canonical Markdown links through `@meridian/markup/links`; image-capable
references also emit an image block. Submitted identities deduplicate by document and URI,
with draft-upload metadata taking precedence. Skills activate once per slug but every
occurrence remains in the blocks. The canonical walk exposes each source reference
through `onReference`; the app projects its owned uploads from those visits without
walking the document again. Draft snapshots and upload lifecycle ownership stay in the app.

## Turn reduction (`src/turns/`)

`createTurnReducer({ store, now })` turns accepted AG-UI events into `Turn` and
`Block` changes on a `TurnStore`: `turns`, `ensureAssistantTurn`,
`upsertAssistantBlock`, `patchTurnStatus`, `bumpEventsApplied`, and
`settleInterruptResponse`, plus an optional `invalidateThreadSnapshot` that an
adapter may use to refetch (reduction never depends on it). The app and `./mf`
reduce chat the same way; neither keeps its own interpretation of events.

- **Instance state.** Buffered interrupt resolutions (a resolution can arrive
  before its component block) live in the reducer instance, with
  `clearPendingInterruptPatchesFor{Thread,Turn}`. Make one reducer per store.
- **No ambient clock.** `now()` returns an ISO timestamp; the reducer never reads
  `Date`, and the package touches no browser or Node global at module load.
- **One store semantics.** `turn-ops.ts` owns turn creation, block upsert by
  sequence (sorted, identical writes are no-ops) and status patching. The app's
  Zustand adapter and `InMemoryTurnStore` both call it. `InMemoryTurnStore` adds
  `hydrate(threadId, turns, nextSeq)` (rejects a snapshot older than the accepted
  floor, like `acceptsThreadSnapshot`). The floor is snapshot freshness only; it
  never filters events. Replay coverage is the caller's subscription cursor
  (`liveState.resumeAfterSeq`, or the admission's for a send).
- **Parity rule.** `apps/app/.../turn-store-parity.test.ts` runs one fixture
  (`test-support/turn-events.ts`) through the app store and `InMemoryTurnStore` and
  requires equal turns. A new event family goes into that fixture; a store change
  that the other store does not share fails there.
- **Stays in the host.** Optimistic rows and `reconcileSnapshotTurns`, cache
  invalidation, thread-list patches, `liveMeta`, account checks, durable-seq
  cursors, and the interrupt response UI. Visible-turn and transcript partition
  policy is also the app's.
- **A new server CUSTOM name** needs a decision in `reduce-turn-event.ts` (apply,
  leave to the snapshot, or ignore) and a reducer test.

## Thread wire protocol and recovery

The thread socket's client wire vocabulary is `subscribe`, `unsubscribe`,
`resume`, `pong`, `interrupt.respond`, `catalog.subscribe`, and
`catalog.unsubscribe`; its server vocabulary is `connected`, `subscribed`,
`event`, `gap`, `error`, `ping`, and `context-catalog-hint`. Turn cancellation is an HTTP
operation through the injected `cancelTurn` port, not a WebSocket message. Keep
these names aligned with `@meridian/contracts/protocol` rather than inferring them from UI actions.

Delivery contract: each handler receives every sequenced event after its own
`after` exactly once and in `seq` order, whatever the timing between live frames
and a replay. Each handler has its own cursor (the cursors are the dedupe), and
subscribe/resume ask from the oldest cursor any handler still needs. From sending
a rewind or reconnect request until its `subscribed` frame, the handlers waiting
on that replay are fenced: live frames are held, then merged with the `catchup`,
sorted by `seq`, and delivered through the cursor rule. Handlers already current
keep receiving live frames meanwhile. One replay is in flight per thread; a
request made meanwhile is sent when `subscribed` arrives.

A `gap` means the server could not replay from the client's cursor. Its frame
carries `fromSeq`/`toSeq`; the transport advances the subscription's resume point
to `toSeq` after notifying `onGap` consumers and before re-subscribing, so the
next read asks for history the server can serve. The truncated catch-up that
follows is skipped by the monotonic seq guard. Consumers recover missing
history through snapshots; each client owns its resync policy.

## Thread socket deadlines

`SocketLifecycleController` owns the attempt phases: connecting, transport-open
awaiting the protocol `connected` frame, and connected. One watchdog starts at
socket creation and ends only on `connected`, close, or teardown. Its default
is 10 seconds (`handshakeTimeoutMs` is injectable); opening or receiving other
frames does not extend it. The separate 45-second ping deadline starts on open
and resets on every inbound frame. Expiry of either deadline retires the socket
before requesting native close and uses the same reconnect backoff as a network
close, without waiting for a close acknowledgement. Retired sockets cannot drive
product callbacks. Both timers are cancelled on retirement or teardown; protocol
`connected` cancels only the handshake watchdog.

Protocol readiness lives in this lifecycle, not in a second transport flag.
Subscriptions still resume from the last delivered cursor after `connected`;
catch-up and gap reconciliation are unchanged. These deadlines bound handshake
wait and inbound silence, not time to recovery: retries still depend on the
server/network returning and client timers running (background suspension can
delay either deadline).

Both compositions use these defaults; neither client gets its own socket
timers. A caller's wait limit (an `./mf` command deadline) bounds how long it
waits for an outcome; these deadlines detect a failed socket. Keep the two
separate: the server pings every 30 seconds, so shortening the 45-second
silence deadline to fit a short command would retire healthy quiet sockets,
and a shorter timer would not make an expired command's report any truer.

## Socket observation

Thread close observation runs before the controller's current-socket guard so
controlled closes from teardown, manual reconnect, and ping timeout remain
visible. The guard still fences every product callback, state transition, and
reconnect decision for stale socket generations. Lifecycle observers receive
only the socket epoch, numeric close code, and `wasClean`; URL and raw close
reason text do not cross the core observer contract.
