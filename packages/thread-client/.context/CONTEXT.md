# Shared thread client contracts

## Thread socket

`ThreadSocketClient` composes the connection lifecycle with the subscription registry. The
lifecycle owns handshake readiness and reconnect; the registry owns replay requests, outcomes,
timers and sequenced delivery. `answerAsk` resolves once and never rejects: the server's reply,
or `unconfirmed` when the frame never left, the socket closed first, the server failed the
request, or the deadline passed.

Timers, clocks and randomness stay late-bound globals, preserving reconnect timing.

## Transcript view model

`viewTranscript(input)` (`view/view-transcript.ts`) is the one pure function that decides which
rows a chat shows and what each reply's items are. It is described in the [transcript view
model][view-decision].

- **The transcript is not a log.** A failed reply a Retry names (`metadata.retryOf` on a stand-in
  or stored turn, or the `retried` input) is not drawn: the Retry takes its place, and a chain of
  failed retries draws only the newest failure.
- **A failure shows only while it can be acted on.** A failed reply that is not the latest row (a
  write-mode line after it does not close it), with no items and no deliveries, has no row. The
  caller passes `anchoredTurnIds` from `chatCards` to keep that row for a card anchored on it. A
  local turn stamped forgotten is hidden the same way. Inherited rows are never filtered by stamp:
  the server already applied the stamps inside the fork's span.
- **Stand-ins and the opening seed** are placed after their `prevTurnId`; the opening seed goes
  first, which equals placing stand-ins first because no producer anchors a stand-in to it. A row's
  `identity` is the server turn id, or null for any row the server hasn't stated, judged by the
  input it arrived in, never an id's shape (local writer turns are recognized by `turn_local_`).
- **Ask-blocked writer messages stay queued.** They remain `awaiting_run` inbox rows until the
  continuation adopts them. `waitingWriterMessages` derives queue membership from the run-state
  record and authoritative asks, so a local answer attempt cannot change delivery classification.
- **`controlSlot`** places a queued switch's notice before the stand-in for the run that will apply
  it when the record says it waits for the next run (`awaiting_run`), otherwise at the tail.
- **Not here:** composer, row actions, control rows, announcements, card display text and failure
  copy. Do not add a card-text or failure-copy rule for one client; card display would move here as
  one projection both clients draw.

Transcript projections preserve identity at the output they own: views are cached by the turn's
blocks array, and summaries, delivery groups and rows are interned at their source anchors and
checked by full projected value. The outer row array is a per-call value.

A call whose card is in the turn shows as that card alone (`hiddenToolCallIds`). Tool identities
pair across the complete turn before splitting folds, because a result can follow intervening model
text in a cold snapshot. Pre-compaction held results (`isNotesStepHeldResult`) stay visible neutral
tool rows, even for tools that normally become a card or child report, and contribute neither a
successful receipt nor a child `return_result`.

### Failure cards (`src/cards/`)

`chatCards` is a pure projection over facts. A card's `key` is its occurrence id
(`${requestId}:${attempt}`, the turn id for a reply, `usage:${threadId}:${seq}`); its copy is a
closed key set the app words. A host's local command state isn't in a snapshot, so `thread view`
passes none and never prints those cards.

## Message documents

Non-editor callers use `buildMessageDoc`: skills, prose and references are inline children of one
paragraph, and authored newlines become `hardBreak` nodes, as in the composer.

`serializeMessageDoc` reads plain JSON, preserving authored spacing and occurrence order. Image
capability, upload intake, file type and ownership belong only to document references. Submitted
identities deduplicate by kind, identity and URI, with document draft-upload metadata taking
precedence. Skills activate once per slug but every occurrence stays in the blocks. The walk
exposes each reference through `onReference`, so the app projects its uploads without walking the
document again.

**Hand-back is the inverse** (`message/hand-back.ts`). `composerDocFromHandedBack` turns handed-back
`UserMessageBlock`s into one composer document (serializing it again gives the same blocks), and
every prepend uses `prependMessageDoc`, failed-send Edit included. `chatReferenceResolver(scope)`
builds a document chip only when the URI proves the owner against this chat; anything else comes
back as link text. The limit and its fix are in [FUTURE](FUTURE).

## Turn reduction (`src/turns/`)

`createTurnReducer({ store, now })` turns accepted AG-UI events into `Turn` and `Block` changes on a
`TurnStore` port.

- **One reducer per store, and no ambient clock.** The reducer never reads `Date`.
- **One store semantics.** `turn-ops.ts` owns turn creation, block upsert by sequence and status
  patching; the one `TurnStore` is `syncedTurnStore`, over the host's cell.
- **One implementation, no parity test.** The reducer's end state is pinned by the fixture in
  `test-support/turn-events.ts` through `reduce-turn-event.test.ts`. A new event family goes into that
  fixture.
- **A new server CUSTOM name** needs a decision in `reduce-turn-event.ts` (apply, leave to the
  snapshot, or ignore) and a reducer test.
- **One value per chat (`sync/synced-thread.ts`).** `SyncedThread` is the plain value a host holds per
  chat. Pure transitions change it, each returning the same value when nothing changed. The delivery
  cursor is the highest frame seq the stream wrote into the value: it only rises and a read leaves it
  alone. `applyRead` treats server turns as the spine (optimistic rows and the running turn survive; a
  terminal read is authoritative) and keeps covered tombstones while an optimistic row awaits its
  answer. The admission answer raises the floor whether or not the local row is still there: the server
  stated it, and the floor only rises.
- **One driver (`sync/thread-sync.ts`).** `createThreadSync(ports)` owns the transcript handler on the
  subscription (a generation fence drops late callbacks), frame order (`StreamDeltaCoalescer`: deltas
  merge per frame; durable blocks, switch, hand-back and forgotten frames flush first; records and the
  `subscribed` state bypass), the debounced refresh, `missing` and the join. `receive` flushes buffered
  deltas, applies the read and its record as one transition, and returns `stale` (changing nothing) when
  the read is below the floor.
- **The join.** `start()` asks for a read and subscribes nothing. While a started generation has no
  handler, a read applies only if it passes the floor *and* its `nextSeq` is above the delivery cursor;
  it then subscribes at the later of its `resumeAfterSeq` and the cursor. A read failing either test
  returns `stale` and the host asks again. Later reads never move the handler. So a generation reduces no
  frame before it has applied a read, and nothing replays from 0 into the sync. A stream write that ends a
  turn requests a `"fresh"` read at once; a durable block for a turn the transcript lacks requests `"any"`.
- **The end-of-turn check.** Per turn the sync keeps sets of ids: *stream-ended* (the reducer's first
  not-terminal to terminal write), *checked*, and *rewritten* (a read put the turn's status or text in the
  cell before the stream ended it, changed a turn the reducer was writing, seeded its text before the
  reducer first wrote to it, or the cell already held it when the sync started; never cleared, so replay
  reopening and re-ending a turn cannot launder it). At the first applied read after a stream end the
  turn's status and own text are compared with the read's. `forgottenBy` is neither compared nor a rewrite.
- **Removal and dividers are fenced by seq.** `removeTurnsIn` keeps a tombstone at the frame's seq;
  `ensureSwitchTurnIn` holds a divider (`HeldDividers`) at its seq. `applySnapshotTo` applies both with one
  rule, `seq < nextSeq` is covered: an older snapshot can neither bring back a removed turn nor drop a held
  divider, and a covering snapshot lists the stored turns itself.
- **A missing anchor is never guessed.** A divider whose `prevTurnId` isn't in the store (user turns aren't
  streamed) is held out of the transcript, and `ThreadSync` asks for a read.
- **Stays in the host:** optimistic-row construction, cache invalidation, thread-list patches, account
  checks, the ask takeover UI, and visible-turn and transcript partition policy.

## Run state (`src/run-state/`)

`run-state-view.ts` owns the only newness and retirement rule: `receiveRecord` keeps the record with the
greatest `version` (`compareSeq`), and an intent retires once the held record is at or past its answer
version. Answers are kept beside the intents for the view's lifetime, so an answer that beats its intent, or
an intent a journal rebuild re-adds, still meets it. The bound is distinct answered switches per store
lifetime, reset by a reload.

A switch never counts as a writer message. `reconcileRetries` is Retry's one retirement rule: a stand-in
whose reservation ended without its reply retires once the record at or past its answer shows another
execution or none.

`messageFate` is the one rule for what became of an admitted writer message, from one applied read's response
whole. Stream frames and the synced value, whose turns and record come from different frames, are never
inputs. Its only caller today is `./mf thread send`; the app does not call it yet.

## Hand-back operation (`src/hand-back/`)

One operation runs Stop, the queue's x and Cancel queue for both clients (`createHandBackOperation`). Clients
contribute only ports and printing.

- **Ports.** `http` returns `{ status, body }` or `{ status: null }`, never a typed error. `accept` retires the
  command and stores the receipt in one write, so a command never outlives its receipt.
- **Order.** Save the command and occurrence (a refused first save is `unsaved`; a refused Retry save keeps an
  already stored command's status; neither posts), add the intent so rows hide, post, classify, and only then
  change state. Confirmed: receive the record, remove `handedBack` and `gone` turns at its version, `accept` the
  content once (or `drop` on a lost race), answer the intent. A failed `accept` is `unwritten`: the command stays
  and a replay brings the same content.
- **Classifier** (`classify.ts`). Confirmed is a 2xx whose body the contract response schema accepts in full, the
  whole `runState` included. Refused is a definite 400, 404 or 409. Anything else is ambiguous and carries the
  frozen request. Validation finishes before any state-changing port is called.
- **Unresolved.** `unresolved()` lists commands that still owe the writer something (`ambiguous`, `unwritten`,
  `unsaved`, `refused`); the first two stay in the store, the last two live in page memory. `subscribe` fires
  after every change to `unresolved()` or `stopFacts()`, so hosts never wrap calls to redraw.
- **Send now** is not a hand-back command: `postSendNow` shares the classifier. A null `cancelledExecutionId`
  means this attempt requested no cancellation.

## Command occurrences (`src/commands.ts`)

A command failure's occurrence is one attempt, `{ requestId, attempt }`. The command's owner allocates it with
`nextOccurrence` before the attempt's first save or post; a projection or render never allocates one. The owners
are the app's chat sends (`chat-submissions/`), queued `/compact` and write-mode switches
(`run-state-slice.ts`), and the hand-back operation.

- **Try again** keeps the command's wire identity (a journaled command's `submissionId`, a hand-back's own
  `requestId`) and starts a new occurrence with a fresh `requestId`. A counter alone would repeat after a refused
  save and a reload.
- **A saved command saves its occurrence with it**, so a reload and another tab see the same attempt. An attempt
  whose occurrence can't be saved is never posted; the press still fails visibly under the new occurrence.
- **Reload differs by owner.** A hand-back's resume continues its last saved occurrence; a send's journal re-drives
  as a new attempt. An attempt still in flight never replaces a failure already shown.

## Thread wire protocol and recovery

The thread socket's client wire vocabulary is `subscribe`, `unsubscribe`, `pong`, `ask.answer`, `catalog.subscribe`
and `catalog.unsubscribe`; its server vocabulary is `connected`, `subscribed`, `event`, `gap`, `error`, `ping`,
`ask.answer.ok`, `ask.answer.error`, and the project channel's `context-catalog-hint`,
`draft-owner-hint` and `project-chats-hint` (a chat's run, question or status changed, so its project's chat
list is stale). Turn cancellation is an HTTP operation through the
injected `cancelTurn` port. Keep these names aligned with `@meridian/contracts/protocol`.

**Every client message except `pong` carries a `requestId`** (`r1`, `r2`, ..., a counter per `ThreadSocketClient`).
There is no `resume`: a reconnect sends one `subscribe` per thread, which the server handles concurrently.

The delivery contract is in the [socket delivery][socket-decision]. A subscription
(`ws-thread-subscription.ts`) holds at most one request in flight, a `waiting` set, the frames `held` for them, a
`position` (`max(subscribed.after, highest delivered seq)`, which only rises, and which a joining cursor is classified
against) and its own retry backoff.

A join is classified against the request in flight (`R`) and the position (`P`):

| State | Join | Effect |
|---|---|---|
| Request in flight | no cursor | cursor `P` if known, else `R`; waits; sends nothing |
| Request in flight, `R` unknown | explicit cursor | **supersedes:** a new request from the oldest cursor |
| Request in flight | cursor `>= R` | waits; the replay in flight carries it |
| Request in flight | cursor `< R` | **supersedes:** a new request from the oldest cursor |
| Lease active | no cursor, or cursor `>= P` | live from now; frames in `(P, cursor]` are skipped |
| Lease active | cursor `< P` | waits alone; a request from the oldest cursor |
| No lease, no request | any | every handler waits; a request from the oldest cursor |
| Disconnected | any | registered and waiting; `connected` sends the request |

How each outcome lands:

- **`subscribed` of the request in flight:** the lease is active, `position` rises to `after`, undefined cursors
  become `after`, and the catch-up merged with the held live frames is delivered in `seq` order through the cursor
  rule, then `onLiveState`.
- **`subscribed` of a superseded request:** applied as a batch of frames to the handlers not waiting. It releases
  nothing and sets no lease.
- **A correlated error:** the lease is void and every handler waits (the server destroys the old lease when a
  replacement passes auth and keeps it when auth fails, and the client cannot tell which). A `retryable` error retries
  that thread alone at its own backoff (jittered exponential to 5 s over five attempts, then 30 s); handlers hear it
  once per episode through `onError`. A non-retryable error is a refusal: the client sends `unsubscribe`, tells the
  handlers, and sends nothing until a handler joins or the connection reconnects.
- **An error with no `requestId`:** ends nothing. With a `threadId` it reaches that thread's handlers; with neither it
  reaches every handler. An error naming a catalog, unsubscribe or retired request is dropped.
- **Connection loss:** requests, held frames and retry state clear, every lease is void, and cursors and positions
  stay; `connected` sends one request per thread.
- **A `gap`** answers the request in flight in place of `subscribed`: every cursor and the position jump to `toSeq`,
  and a new request goes out before `onGap`, with no backoff because the server answered. A callback that removes the
  subscription cancels the replacement request just installed.

A deadline voids every handler's lease, so a later retry recovers any discarded older batch.

A cursorless `subscribe` starts at the server's current head, stated in `subscribed.after`; explicit `"0"` requests
history. Cursorless handlers joining an active lease start at its known position and receive no synthetic
acknowledgment, so their durable projections must acquire on mount as well as reconcile on real acknowledgments.
`subscribed.state.resumeAfterSeq` is in journal units and is not a cursor. Socket `ThreadLiveState` carries no cursor;
HTTP snapshot cursors stay in `liveState.resumeAfterSeq`.

## Thread socket deadlines

One handshake watchdog (default 10 s, `handshakeTimeoutMs` is injectable) starts at socket creation and ends only on
`connected`, close or teardown; opening or receiving other frames does not extend it. The 45-second ping deadline
starts on open and resets on every inbound frame. Expiry of either retires the socket before requesting native close
and uses the same reconnect backoff as a network close, without waiting for a close acknowledgement. A socket still
CLOSING when a new connection starts is retired the same way, so its close is reported exactly once and never closes
the new generation.

Protocol readiness lives in this lifecycle, not in a second transport flag.

A replay request has its own deadline, `DEFAULT_WS_REPLAY_DEADLINE_MS` (20 s), from its send to its outcome; pings do
not reset it, and expiry fails that thread's request and never drops the connection. It is sized from a probe through
the real socket, server and Postgres (dev stack, loaded 24-CPU host; send to `subscribed`, median of three runs):

| Case | Cold hub | Warm hub |
|---|---:|---:|
| 10k rows, cursor 100 behind | 94 ms | 11 ms |
| 100k rows, cursor 100 behind | 753 ms | 11 ms |
| 100k rows, cursor 0 (100,200 frames) | 780 ms | 669 ms |
| 100k rows, cursor 2,000 behind, below the hot cache | | 576 ms |
| five 50k-row threads requested at once | 1.7 s | |

The cost is journal paging, about 7 ms per 1,000 rows, cold or historical; 20 s is ten times the slowest case measured
and meets a cold drain of roughly 2.5 million rows. The probe did not measure production builds, remote networks, cold
disk caches or contention from active streams. These deadlines bound handshake wait and inbound silence, not time to
recovery.

A caller's wait limit (an `./mf` command deadline) bounds how long it waits for an outcome; these deadlines detect a
failed socket. Keep the two separate: the server pings every 30 seconds, so shortening the 45-second silence deadline
to fit a short command would retire healthy quiet sockets.

## Socket observation

Thread close observation runs before the controller's current-socket guard so controlled closes from teardown, manual
reconnect and ping timeout stay visible. The guard still fences every product callback, state transition and reconnect
decision for stale socket generations. Lifecycle observers receive only the socket epoch, numeric close code and
`wasClean`; URL and raw close reason text do not cross the core observer contract.

## Client failure delivery

`FailureLog` is an injected diagnostics port, not a failure store. Command owners log before retaining a failed attempt
and when they retire it; the bounded batch adapter only handles delivery and deduplication. Retry replaces an occurrence,
not its frozen wire request. Send now allocates a request identity independent of the execution it targets.

Socket-wide terminal episodes share one occurrence across affected threads; a refused subscribe owns a per-thread
occurrence. `onUnavailable` carries these separately from `onError`, and retryable replay and reconnect errors create no
failure card. A matching subscribed acknowledgment clears that thread; last-handler removal retires a per-thread refusal.

## Asks (`src/asks/`)

Reads, `meridian.ask` frames and answer replies all go through `receiveAsks`, which never moves a status back (pending,
open, then one resolution), so their arrival order doesn't matter. A resolved ask retires this device's attempt.

- `openAsk` is the ask that takes over the composer: open, on the chat's nearest assistant turn, and not being answered
  from this device. A failed attempt rides along so the takeover can offer Retry.
- The asking run's `RUN_FINISHED` result sets its turn to `awaiting_answer`. Later `meridian.ask` resolution frames set it
  to `complete` or `cancelled`; no run frame exists for that post-run transition.
- A Retry of the same answer reuses its `submissionId`; a different answer is a new submission. `ask_not_open` takes the
  winning resolution from the reply when it has one. Without one, the attempt goes `settling` until a read says how the ask
  ended; a failed read leaves it `unsettled`, and the takeover offers only to read again (`settleAsk`).

[view-decision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/chat/sync.md#one-pure-transcript-view-model
[socket-decision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/chat/sync.md#each-socket-handler-gets-its-events-exactly-once
