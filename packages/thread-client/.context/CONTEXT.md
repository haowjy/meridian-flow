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

## Transcript view model

`viewTranscript(input)` (`view/view-transcript.ts`) is the one pure function that
decides which rows a chat shows and what each reply's items are. The app builds
the input from its store and hooks; `./mf thread view` builds it from a snapshot
and says what it left out. The decision and its rejected alternatives are in the
[transcript view model ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/platform/client/transcript-view-model.md).

- **The transcript is not a log.** A failed reply a Retry names
  (`metadata.retryOf` on a stand-in or stored turn, or the `retried` input) is
  not drawn: the Retry takes its place, and a chain of failed retries draws only
  the newest failure.
- **A failure shows only while it can be acted on.** A failed reply that is not
  the latest row (a write-mode line after it does not close it), with no items
  and no deliveries, has no row. The app passes `refused` (ids whose Retry the
  server refused) to keep that row for the refusal card; `./mf` passes none.
- **Stand-ins and the opening seed** are placed after their `prevTurnId`; the
  opening seed goes first, which equals placing stand-ins first because no
  producer anchors a stand-in to it. A row's `identity` is the server turn id,
  or null for any row the server hasn't stated, judged by the input it arrived
  in, never an id's shape (local writer turns are recognized by `turn_local_`).
- **`controlSlot`** places a queued switch's notice before the stand-in for the
  run that will apply it when the record says it waits for the next run
  (`awaiting_run`), otherwise at the tail. A `waiting` switch, or one only this
  device holds, stays at the tail.
- **Counts, kinds and numbers, never strings.** Lingui and `Intl` stay in the
  app. Not here: composer, row actions, control rows, interrupts, announcements,
  card display text and failure copy. Do not add a card-text or failure-copy
  rule for one client; card display would move here as one projection both
  clients draw.
- `hidden` (from `hiddenWriterTurns`) keeps rows out while a hand-back is in
  flight; `onContractFailure` lets the caller report a persisted record that
  misses a contract.

Turn-metadata readers (compaction, handoff seed, thread references) live in
`@meridian/contracts/threads` because they mirror the server's metadata codecs.

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

**Hand-back is the inverse** (`message/hand-back.ts`). `composerDocFromHandedBack`
turns handed-back `UserMessageBlock`s into one composer document (serializing it
again gives the same blocks), and `prependMessageDoc` puts it above typed text with
a blank line. Every prepend in the app uses it, failed-send Edit included. A chip is
a `RestorableReference` (`MessageReference` plus `fileType` and owner authority);
`chatReferenceResolver(scope)` builds one only when the URI proves the owner
against this chat (its lineage handle for `scratch://`, `@/` uploads in a No Work
chat, its own Work's `@slug`, or a project or user scheme). Anything else comes back
as link text. An image block in the message makes the chip an image. The limit
and its fix are in [FUTURE](FUTURE).

## Turn reduction (`src/turns/`)

`createTurnReducer({ store, now })` turns accepted AG-UI events into `Turn` and
`Block` changes on a `TurnStore` port. The app and `./mf` reduce chat the same
way; neither keeps its own interpretation of events. Reduction never depends on
the optional `invalidateThreadSnapshot` an adapter may supply.

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
- **Removal and dividers are fenced by seq.** `removeTurnsIn` (a
  `meridian.messages.handed_back` frame, or the same fact in an answer) removes
  turns and keeps a tombstone at the frame's seq. `ensureSwitchTurnIn` installs a
  `meridian.write_mode.switched` frame's divider right after its `prevTurnId`
  and holds it (`HeldDividers`) at the frame's seq. `applySnapshotTo` applies both
  fences with one rule, `seq < nextSeq` is covered: an older snapshot can neither
  bring back a removed turn nor drop a held divider, and a covering snapshot lists
  the stored turns itself. The app's store keeps tombstones a snapshot covers while
  an optimistic writer row still waits for its answer, so a late admission answer
  can't resurrect a handed-back message.
- **A missing anchor is never guessed.** A divider whose `prevTurnId` isn't in
  the store (another client's message: user turns aren't streamed) is held out of
  the transcript. `dividersAwaitingAnchorIn` lists those, and both hosts ask it:
  the app's subscriber refreshes the snapshot, and `./mf`'s `followThread`
  hydrates one within its deadline. Sharing the reducer alone is not enough:
  `./mf` would hold such a divider forever unless the waiting list and the
  recovery are shared too.

## Run state (`src/run-state/`)

The chat's `RunState` record and this device's intents, as a store-free value.
`run-state-view.ts` owns the only newness and retirement rule: `receiveRecord`
keeps the record with the greatest `version` (`compareSeq`), and an intent
(message, switch, withdraw, hand-back request) retires once the held record is at
or past its answer version. Answers are kept beside the intents for the view's
lifetime, so an answer that beats its intent, or an intent a journal rebuild
re-adds, still meets it. The bound is distinct answered intents per store
lifetime, reset by a reload.

Everything else (`fold-messages.ts`, `fold-switches.ts`, `retry.ts`) is a pure
selector over the view; hosts hold the view and call selectors.
`unheldWriterMessages` (record messages the transcript lacks) is the passive-tab
refresh signal. A switch never counts as a writer message. `reconcileRetries` is
Retry's one retirement rule: a stand-in whose reservation ended without its reply
retires once the record at or past its answer shows another execution or none.

`messageFate` (`message-fate.ts`) is the one rule for what became of an admitted writer
message, from a single snapshot's record and turns: waiting, handed back (a user turn
absent from the snapshot; a snapshot that hides turns another way must expose
`handedBackIds`), answering or answered by the chain's last reply (the deliverer's
execution, then Retries by `metadata.retryOf`), or unproven. It is server-only (the app
follows no run since #849; `./mf thread send` is its caller) and stream frames are never inputs.

The record arrives whole on every carrier (snapshot, `subscribed`,
`meridian.run_state`, every command answer), so no host composes one from parts.

## Hand-back operation (`src/hand-back/`)

One framework-free operation runs Stop, the queue's x and Cancel queue for the app and `./mf`
(`createHandBackOperation({ threadId, ports })`: `press`, `resume`, `retry`, `dismiss`,
`reconcile`, `unresolved`). Clients contribute only ports and printing.

- **Ports.** `http(path, body)` returns `{ status, body }` or `{ status: null }`, never a typed
  error. `runState` is the narrow `RunStatePort` (receive a record; add, answer, fail or drop a
  hand-back intent); `viewRunStatePort` builds one over a held `RunStateView`. Failing an intent is
  `failIntent(view, id)` in `run-state-view.ts`, the one transition: the local-view port calls it and
  the app store dispatches `failHandBack` to it (an absent intent stays absent). `removeTurns(ids,
  version)` carries the record's version. `store` is the pending-command store (`pending`,
  `record`, `accept`, `drop`; each write says whether it took). `accept` retires the command and
  stores the receipt in one write, so a command never outlives its receipt.
- **Order.** Save the command (a refusal sends nothing: `unsaved`), add the intent so rows hide,
  post, classify, and only then change state. Confirmed: receive the record, remove `handedBack`
  and `gone` turns at its version, `accept` the content once (or `drop` on a lost race, writing
  nothing), answer the intent. A failed `accept` is `unwritten`: the command stays and a replay
  brings the same content.
- **Classifier** (`classify.ts`). Confirmed is a 2xx whose body the contract response schema
  (`stopResponseSchema`, `handBackResponseSchema`, `sendNowResponseSchema`) accepts in full, the
  whole `runState` included. Refused is a definite 400, 404 or 409. Anything else (no answer, 5xx,
  a body that fails validation) is ambiguous and carries the frozen request. Validation finishes
  before any state-changing port is called.
- **Unresolved and cards.** `unresolved()` lists commands that still owe the writer something
  (`ambiguous`, `unwritten`, `unsaved`, `refused`); the first two stay in the store, the last two
  live in page memory. `reconcile()` (host-called) drops entries whose command left the store.
  `subscribe` fires after every change to `unresolved()` or `stopFacts()` from any call, so hosts
  never wrap calls to redraw. `handBackCards(unresolved, view)` projects the notice-stack cards (copy,
  count, retry or dismiss) from them plus a failed Send now, with no dependence on rows.
- **Send now** is not a hand-back command: `postSendNow(ports, threadId, body)` shares the
  classifier and returns confirmed (`cancelledExecutionId`; null means this attempt requested no
  cancellation), refused, or ambiguous with the frozen body. `sendNowRequest(view)` builds the body.
- **L1 seams.** The builders (`stopRequest`, `waitingWriterMessages`, `sendNowRequest`) read only a
  `RunStateView`; a shared session would implement `RunStatePort` so command records pass its one
  version check.

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
carries `fromSeq`/`toSeq`; after notifying `onGap` consumers, the transport moves
every handler's cursor up to `toSeq` and re-subscribes, so the next read asks
for history the server can serve. The gap answers the request in flight in place
of `subscribed`, so the re-subscribe goes out at once and the fence stays up for
its waiters. Frames at or below `toSeq` are skipped by the cursor rule. Consumers
recover missing history through snapshots; each client owns its resync policy.

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
