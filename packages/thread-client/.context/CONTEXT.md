# Shared thread client contracts

## Thread socket

`ThreadSocketClient` composes the connection lifecycle with the subscription
registry. The lifecycle owns handshake readiness and reconnect; the registry owns
replay requests, outcomes, timers and sequenced delivery. The client routes wire
messages, connection notifications, catalog subscriptions and interrupt answers.
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
  and no deliveries, has no row. The caller passes `anchoredTurnIds` from `chatCards` to keep that row for
  a card anchored on it (a refused Retry's, say); `./mf` passes the same projection's set.
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

Pre-compaction held results use the shared contracts discriminator
`isNotesStepHeldResult`. They remain visible neutral tool rows, even for tools
whose successful invocation normally becomes a custom card or child report.
They contribute neither a successful receipt nor a child `return_result`.

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
against this chat (its lineage handle for `scratch://`, `uploads://@c15/` for this chat's own
chat, its own Work's `@w3`, or a project or user scheme). Anything else comes back
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
  sequence (sorted, identical writes are no-ops) and status patching. The one `TurnStore`,
  `syncedTurnStore`, calls it over the host's `SyncedThread`. The floor is snapshot freshness
  only; it never filters events. Replay coverage is the subscription cursor
  (`liveState.resumeAfterSeq` of the join read, or the cell's delivery cursor).
- **One implementation, no parity test.** The reducer's end state is pinned by the fixture in
  `test-support/turn-events.ts` through `reduce-turn-event.test.ts`, which runs the reducer over
  `syncedTurnStore` with a plain cell. A new event family goes into that fixture. The reducer and
  turn store are not part of the package's public exports: a host composes `createThreadSync`.
- **One value per chat (`sync/synced-thread.ts`).** `SyncedThread` is the plain value a host
  holds per chat: turns, tombstones, held dividers, forgotten stamps, the snapshot floor, the
  durable-block cursor, the delivery cursor (the highest frame seq the stream wrote into the value; it
  only rises, `raiseDeliveryCursor`, and a read leaves it alone), the reducer's event counter and the
  run-state slice. Pure transitions
  change it (`applyRead`, `acceptDurableBlockSeq`, `acknowledgeAdmission`, `removeTurns`,
  `markForgotten`, ...), each returning the same value when nothing changed. `applyRead` runs
  `applySnapshotTo` then `reconcileSnapshotTurns` (server turns are the spine; optimistic rows
  and the running turn survive; a terminal read is authoritative), moves the cursor and the
  floor, and keeps covered tombstones while an optimistic row awaits its answer.
  `syncedTurnStore({ cell, now, ...callbacks })` is the `TurnStore` the reducer writes through,
  over the host's cell (`get`/`set` for one chat); callbacks are the host's effects and run
  after the write. The app's Zustand store holds one value per chat (`syncedByThread`). The
  admission answer raises the floor whether or not the local row is still there: the server
  stated it, and the floor only rises.
- **One driver (`sync/thread-sync.ts`).** `createThreadSync(ports)` keeps one chat's value in
  step with the server for any host. It owns the transcript handler on the subscription (added by
  the first read that joins, removed on `stop()`; a generation fence drops late callbacks), frame routing and
  order (`StreamDeltaCoalescer`: deltas merge per frame; durable blocks, switch, hand-back and
  forgotten frames flush first; records and the `subscribed` state bypass), the debounced
  refresh timer (`REFRESH_DEBOUNCE_MS`; unconditional triggers win over gap-only), `missing`
  (a held divider awaits its anchor, or the record names a waiting writer message the transcript
  lacks, asked at timer fire), `receive(read)`, the join, and its reducer instance. It never
  fetches: `requestSnapshot("fresh" | "any")` asks the host, and every completed read comes back
  through `receive`, which flushes buffered deltas, applies the read and its record as one
  transition (`applyRead`), and returns `stale` (changing nothing) when the read is below the
  floor. **Reads arrive validated.** Each host parses the snapshot with the contracts'
  `threadSnapshotSchema` at its HTTP read boundary (the app's `threads-api.ts`, the CLI's
  `Session.request` with `decode: jsonResponse(threadSnapshotSchema)`) before calling `receive`, so an invalid response is a read failure
  there. The sync neither validates nor catches: an exception inside it is a programming error
  and propagates. **The join:** `start()` asks for a read (`requestSnapshot("any")`) and subscribes nothing.
  While a started generation has no handler, a read applies only if it passes the floor *and* its
  `nextSeq` is above the delivery cursor (it was taken after every frame the cell holds); it then
  subscribes at the later of its `resumeAfterSeq` and the cursor. A read failing either test
  returns `stale` and the host asks again. Later reads never move the handler. So a generation
  reduces no frame before it has applied a read, on an empty cell and a kept one alike, and
  nothing replays from 0 into the sync. Stream writes raise the cursor (the coalescer hands its
  flush the run's highest seq; `stop()` flushes first; a gap raises it to `toSeq`). A stream write that ends a turn requests a `"fresh"` read at
  once; a durable block for a turn the transcript lacks requests an `"any"` read. Host effects go
  through `observe(observation)` after the write each follows (`event`, `live`, `gap`, `read`,
  `check`, `turn`, `interruptSettled`, `error`).
- **The end-of-turn check.** Per turn the sync keeps sets of ids: *stream-ended* (the reducer's
  first not-terminal to terminal write), *checked*, and *rewritten* (a read put the turn's status
  or text in the cell before the stream ended it, or changed a turn the reducer was writing, or
  seeded its text before the reducer first wrote to it, or the cell already held it when the
  sync started; never cleared, so replay reopening and re-ending a turn cannot launder it). At
  the first applied read after a stream end the turn's status and own text (the text items of
  `viewAssistantTurn`, not the transcript) are compared with the read's, and a `check`
  observation carries `rewritten` and the `diffs`. `forgottenBy` is neither compared nor a
  rewrite.
- **Moved here from the app:** `reconcileSnapshotTurns` (`turns/`), the run-state slice
  (`run-state/run-state-slice.ts`, with `JournalSwitch`) and `StreamDeltaCoalescer`
  with `frameScheduler` (`sync/`, subpath `@meridian/thread-client/sync`).
- **Stays in the host.** Optimistic-row construction, cache invalidation, thread-list
  patches, account checks and the interrupt response UI. Visible-turn and transcript partition
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
  `ThreadSync` asks for a read, in the app and in `./mf` alike (`missing`, at timer fire).
  The waiting list and the recovery are the sync's, so neither host keeps its own.

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
message, from one applied read's response whole (`messageFate({ messageId, admittedVersion, read })`):
waiting, handed back (a user turn
absent from the snapshot; a snapshot that hides turns another way must expose
`handedBackIds`), answering or answered by the chain's last reply (the deliverer's
execution, then Retries by `metadata.retryOf`), or unproven. It is a pure selector over one
snapshot that any client can use; its only caller today is `./mf thread send` (the app does not
call it yet). Stream frames and the synced value, whose turns and record come from different
frames, are never inputs.

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
- **Order.** Save the command and occurrence (a refused first save is `unsaved`; a refused Retry
  save keeps an already stored command's status; neither posts), add the intent so rows hide,
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
  never wrap calls to redraw. `chatCards` folds them (with a failed Send now) into the composer's card stack (copy,
  count, try again or dismiss), with no dependence on rows. Each command carries an `occurrence: { requestId, attempt }`,
  allocated before any save or post. Retry mints a new occurrence and saves it, including when the
  previous save failed; the stable outer command id still replays the same server decision.
  Joining an in-flight attempt and reload's resume retain the saved occurrence.
  If saving a Retry occurrence fails, nothing new is posted: an already durable command keeps
  its unresolved status and recovery card, not the never-saved classification. Reload can only
  recover the last occurrence whose save succeeded. The attempt returns `unsaved`, while its
  card still describes the durable command's unresolved status.
- **Send now** is not a hand-back command: `postSendNow(ports, threadId, body)` shares the
  classifier and returns confirmed (`cancelledExecutionId`; null means this attempt requested no
  cancellation), refused, or ambiguous with the frozen body. `sendNowRequest(view)` builds the body.
- **L1 seams.** The builders (`stopRequest`, `waitingWriterMessages`, `sendNowRequest`) read only a
  `RunStateView`; a shared session would implement `RunStatePort` so command records pass its one
  version check.

## Thread wire protocol and recovery

The thread socket's client wire vocabulary is `subscribe`, `unsubscribe`, `pong`,
`interrupt.respond`, `catalog.subscribe`, and `catalog.unsubscribe`; its server
vocabulary is `connected`, `subscribed`, `event`, `gap`, `error`, `ping`, and
`context-catalog-hint`. Turn cancellation is an HTTP operation through the injected
`cancelTurn` port, not a WebSocket message. Keep these names aligned with
`@meridian/contracts/protocol` rather than inferring them from UI actions.

**Every client message except `pong` carries a `requestId`** (`r1`, `r2`, ..., a counter
per `ThreadSocketClient`). `subscribed`, `gap` and `error` echo the id of the message
they answer, and `subscribed.after` states the cursor the server's lease starts above.
There is no `resume`: a reconnect sends one `subscribe` per thread, which the server
handles concurrently.

Delivery contract: each handler receives every sequenced event above its own cursor
exactly once and in `seq` order, whatever the timing between live frames and a replay,
and every replay request ends with an outcome the client can attribute to it. Each
handler has its own cursor (the cursors are the dedupe), and a request asks from the
oldest defined cursor. A subscription (`ws-thread-subscription.ts`) holds at most one
request in flight, a `waiting` set (handlers that need a replay before they may take a
live frame), the frames `held` for them, a `position` (`max(subscribed.after, highest
delivered seq)`, which only rises, and which a joining cursor is classified against)
and its own retry backoff.

A join is classified against the request in flight (`R`) and the position (`P`):

| State | Join | Effect |
|---|---|---|
| Request in flight | no cursor | cursor `P` if known, else `R`; waits; sends nothing |
| Request in flight | cursor `>= R` | waits; the replay in flight carries it |
| Request in flight | cursor `< R` | **supersedes:** a new request from the oldest cursor |
| Lease active | no cursor, or cursor `>= P` | live from now; frames in `(P, cursor]` are skipped |
| Lease active | cursor `< P` | waits alone; a request from the oldest cursor |
| No lease, no request | any | every handler waits; a request from the oldest cursor |
| Disconnected | any | registered and waiting; `connected` sends the request |

A request ends in exactly one of five ways: its `subscribed`, its `gap`, its error, its
deadline, or the connection's loss.

- **`subscribed` of the request in flight:** the lease is active, `position` rises to
  `after`, undefined cursors become `after`, and the catch-up merged with the held live
  frames is delivered in `seq` order through the cursor rule, then `onLiveState`.
- **`subscribed` of a superseded request:** applied as the batch of frames it is, to the
  handlers not waiting (the socket's order puts it before that lease's live frames). It
  releases nothing and sets no lease. Dropping it would lose a frame for a handler that
  was not waiting.
- **A correlated error:** the lease is void and every handler waits (the server destroys
  the old lease when a replacement passes auth and keeps it when auth fails, and the
  client cannot tell which). A `retryable` error retries that thread alone at its own
  backoff (jittered exponential to 5 s over five attempts, then 30 s); handlers hear it
  once per episode through `onError`. A non-retryable error is a refusal: the client sends
  `unsubscribe`, tells the handlers, and sends nothing until a handler joins or the
  connection reconnects. The connection is never dropped for a replay.
- **An error with no `requestId`:** ends nothing. With a `threadId` it reaches that
  thread's handlers; with neither it reaches every handler. An error naming a catalog,
  unsubscribe or retired request is dropped.
- **Connection loss:** requests, held frames and retry state clear, every lease is
  void, and cursors and positions stay; `connected` sends one request per thread.

Request and retry transitions, including timers, belong to the subscription
registry, including joins, reconnect, refusal and acknowledgement classification. Failure and gap recovery are installed before notifying consumers:
callbacks may unsubscribe or replace a subscription. Every request send checks
registry identity and nonempty handlers, so detached work cannot replace a
new handler's server lease.
Superseded ids belong to the pending request, not the subscription: a matching settlement, failure, gap,
removal or connection loss retires them before callbacks. Before settlement, an
older acknowledgement still contributes frames; socket ordering prevents a
valid older acknowledgement first arriving after the newer one settles. A deadline
voids every handler's lease, so a later retry recovers any discarded older batch.


A `gap` answers the request in flight in place of `subscribed`: every cursor and
the position jump to `toSeq`, and a new request goes out before `onGap` (the server
answered, so no backoff). Consumers recover missing history through snapshots; each
client owns its resync policy. A callback that removes the subscription cancels the
replacement request just installed.

A cursorless `subscribe` keeps its meaning (replay from 0; `subscribed.after` is `"0"`).
`subscribed.state.resumeAfterSeq` is in journal units and is not a cursor.

## Thread socket deadlines

`SocketLifecycleController` owns the attempt phases: connecting, transport-open
awaiting the protocol `connected` frame, and connected. One watchdog starts at
socket creation and ends only on `connected`, close, or teardown. Its default
is 10 seconds (`handshakeTimeoutMs` is injectable); opening or receiving other
frames does not extend it. The separate 45-second ping deadline starts on open
and resets on every inbound frame. Expiry of either deadline retires the socket
before requesting native close and uses the same reconnect backoff as a network
close, without waiting for a close acknowledgement. Retired sockets cannot drive
product callbacks. A socket still CLOSING when a new connection starts is retired
the same way, so its close is reported exactly once and never closes the new
generation. Both timers are cancelled on retirement or teardown; protocol
`connected` cancels only the handshake watchdog.

Protocol readiness lives in this lifecycle, not in a second transport flag.
After `connected` the client sends one `subscribe` per thread from its oldest cursor.
A replay request has its own deadline, `DEFAULT_WS_REPLAY_DEADLINE_MS` (20 s), from
its send to its outcome; pings do not reset it, and expiry fails that thread's request
(it retries alone) and never drops the connection. It is a backstop for a request the
server never answers, sized from a probe through the real socket, server and Postgres
(dev stack, loaded 24-CPU host; send to `subscribed`, median of three runs):

| Case | Cold hub | Warm hub |
|---|---:|---:|
| 10k rows, cursor 100 behind | 94 ms | 11 ms |
| 100k rows, cursor 100 behind | 753 ms | 11 ms |
| 100k rows, cursor 0 (100,200 frames) | 780 ms | 669 ms |
| 100k rows, cursor 2,000 behind, below the hot cache | | 576 ms |
| five 50k-row threads requested at once | 1.7 s | |

The cost is journal paging, about 7 ms per 1,000 rows, cold or historical; 20 s is ten
times the slowest case measured and meets a cold drain of roughly 2.5 million rows. The
probe did not measure production builds, remote networks, cold disk caches or
contention from active streams. These deadlines bound handshake
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

## Durable tool pairing

Delivery views pair tool identities across the complete turn before splitting
ordered prose/process folds. Results can follow intervening model text in a cold
snapshot; the normalized ToolView travels into each fold without encoding it back into
protocol blocks. Visibility, reports, folds and Work receipts consume the same
turn-wide normalization. Source blocks remain unchanged identity/raw data.
