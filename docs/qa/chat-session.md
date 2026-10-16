# Chat session recipes

Runtime checks that the chat the browser draws and the chat `./mf` prints are the
same view model. `./mf` reaches the browser's answer to "which rows does the writer
see, and what does each reply show" because both run `viewTranscript` from
`@meridian/thread-client`; this page is where the recipes for the session's commands
will grow, one per command. It holds the transcript comparison and the live-sync recipes
(SY-01 to SY-07).

## Compare a chat in the browser with `./mf thread view`

- **Protects:** the app draws the view model it is handed, and nothing in a
  component re-decides a row. A divergence is a binding bug (a component dropping,
  reordering or re-classifying) or an input the two sides don't share.
- **Stack:** mock model, an owned worktree stack (`MODEL_PROVIDER=mock pnpm dev`,
  `pnpm portless:list`). **Confirm route ownership before any `./mf seed` or send** (#615):
  `pnpm portless:list` must show routes for your own session, and `MF_APP_URL` and
  `MF_SERVER_URL` must be passed explicitly. A detached checkout can report "started" while
  its routes belong to another checkout, and `./mf` would then write into that checkout's
  database. For a base comparison, put the base on a throwaway branch
  (`git worktree add -b <name> <path> <base>`), not `--detach`, so its stack gets its own
  prefix. When done, stop only your stacks with `pnpm dev --stop` in each worktree; never
  `pkill` or `killall` by pattern, which reaches every worktree's stack. Build one chat
  with `./mf` so both sides read the same durable turns:

  ```bash
  ./mf seed tools/mf/fixtures/basic.json --json            # chat + opening reply
  ./mf thread send "$T" 'Draft a scene' --mock @tools/mf/fixtures/mock-write.json --json
  ./mf thread send "$T" 'Spawn a check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect","name":"Check","mode":"background"}}]},{"text":"Child."},{"text":"Started."},{"text":"Done."}]' --json
  ./mf api POST /api/threads/$T/controls --data '{"id":"<uuid>","control":{"kind":"compact"}}'
  ```

- **Steps:**
  1. Read the model: `./mf thread view "$T" --full --json > view.json`. `--full --json` is
     the inspectable form: tool inputs, results, metadata and Work receipts, raw card content, report payloads, the
     handoff brief, delivery bodies and writer occurrences. Text mode
     (`./mf thread view "$T"`) summarizes (`you:`, `reply: read 2 docs, 1 step`,
     `compaction:`, `queued: N`) and omits all of that; use it to orient, not to compare.
  2. Open the chat in the browser (`/p/<projectId>/chats/<threadId>`, signed in through
     the stack's dev login).
  3. **Scroll every row into view and expand every process fold first.** The list is
     virtualized, so rows outside the viewport are not in the DOM, and folds start
     collapsed, so their tools are not either. A fold can collapse again when its row
     remounts, so capture each row while it is mounted and expanded, not from one later
     whole-page snapshot.
  4. Compare, per row in order, by **row identity** (`identity.turnId`, `identity.kind`,
     `identity.occurrence`; the DOM carries the turn id as `data-turn-id` and the kind as
     `data-chat-turn-kind`; compaction and handoff-seed rows carry `data-turn-id` on their
     list item too), **row kind**, **render-item kinds** (`data-turn-item-kind`:
     `process`, `text`, `report`, `artifact`, `delivery`) and **visible text** (the
     `text` of `text` items and a writer row's `text`).
     - **Deliveries:** the JSON lists a reply's delivery groups as a last `delivery` item
       (`groups`, each a list of events), the DOM's trailing `delivery` item; a group of
       several is one merged row.
     - **Text:** the DOM collapses newlines and draws references as chips, so compare after
       whitespace normalization and after rendering a reference to its title (the JSON's
       `text` holds the reference as Markdown, and `occurrences` locates it).
     - **Folds:** compare fold contents by the tool names and targets in the full JSON
       (`runs[].tools[].name`, `input`), not by label words.
     - **Reports, brief:** compare a report's `summary` and a handoff row's `brief`
       against the DOM text.
     - **Deliveries' `message` bodies** are carried but the app does not draw them. Compare
       a completion by its child (`agentName`, `childThreadId`), `title` and `outcome`.
     - **Cards:** the view prints only a card's kind and its raw `content` (props) and
       `direct` result. Card display text and failure copy (a choice's option label, the
       refusal wording of a stored `error`) are decided per card in React until "Interrupt
       presentation" moves them, so they are not comparable yet. Compare raw props and the
       stored `error` and `providerError` only as data.
     - **Work receipts:** a Work tool's `metadata.workReceipt` (also `tools[].workReceipt`)
       sets the folded tool's title (`operation` and `workName`, e.g. "Deleted Work
       Northern Gate"); the reply's `workReceipts` are the receipt rows under it. Compare
       those fields, not label wording.
  5. Never compare render keys. `renderKey` is the React key and may change when a
     local turn is renamed to its server id.
- **Expect:** same rows in the same order; each reply's item kinds match, with a fold
  whose `visible` is false absent from the DOM; folds expand to the tools the model
  lists (`runs[].tools`); the fold's label words the model's `digest` counts ("Read 2
  documents"); a reply with `continuing: true` has no action row.
- **Known input differences, not defects.** `inputs` says what `./mf` left out:
  - local records and stand-ins (a Retry's pending reply, an unsent message), so
    compare only settled chats;
  - live subagent activity, so a reply that the browser holds open for a running
    background subagent shows `continuing: false` in `./mf`;
  - inherited fork history, omitted from `./mf`'s rows;
  - background report bodies (`inputs.backgroundReports`): the browser fetches each
    child's report for its card, and the view has none;
  - change trails (`inputs.changeTrails`), also fetched by the browser;
  - copy and the receipt rows under a reply (Undo, "Edited 1 document") are the app's
    drawing of Work and lineage reads, not view-model rows;
  - a pending reply's DOM `data-turn-id` is its client id, so it is not row identity: a
    Retry stand-in carries the id it will be stored under before the request leaves the
    browser, and nothing in the DOM marks it local;
  - inspection data the row doesn't draw: a compaction's trigger and token counts, tool
    call ids, usage numbers.
- **Evidence:** `view.json`, the browser snapshot or DOM extract per row, and the row
  table of identity, kind, items and text from both sides. Record commit, date, stack
  and provider.
- **Last run:** 2026-10-13, PR C at `9fc683109` (before the receipt and card-kind pass),
  mock provider, owned `mf-transcript-view` stack. All 40 rows matched on identity, kind,
  ordered items, normalized text, tool targets, drafted wording and the handoff brief,
  and the first 12 rows had no regression against the base. Background report bodies,
  delivery bodies and stored 402 copy differed as listed above. Not exercised: a merged
  delivery group, a completed system custom card, a queued writer row, inherited
  history, a reasoning fallback. Report:
  [probe-pr-c-rerun.md](https://github.com/haowjy/meridian-flow-docs/blob/main/work/mf-client-unification/reports/probe-pr-c-rerun.md).

## Live sync (SY-01 to SY-07)

Browser checks for the thread sync the app and `./mf` share: how a chat opened mid-reply joins the
journal replay, how a read applies, and how a gap or a missing row recovers. They are the gate for
every change under `packages/thread-client/src/sync/`, the store, or the app's sync binding. Run each at
desktop width (1280 wide) with `agent-browser`, look at the screenshots, and judge the screen against the
durable transcript (`./mf thread view`). Record the commit, date, provider and evidence path after each
run, in the active work directory. There is no SY-08: a hand-back frame removing a row the browser shows is
[QC-04](queue-controls.md#qc-04-two-tabs), which the same gate runs.

**Setup.** As above (`MODEL_PROVIDER=mock pnpm dev --no-tailscale`, routes that carry this worktree's
prefix, `MF_APP_URL` and `MF_SERVER_URL` passed explicitly, sign in at `/api/auth/dev-login`, one named
`agent-browser --session`). `./mf` creates state and reads durable state; every step under test is in the
browser. `T` is a new thread (`./mf thread create --title SY-0N`).

**A reply that is mid-stream.** The mock sends a step's whole text in one burst after its `delayMs`, so a
long delay is not a slow stream. Stage "mid-reply" with a text-and-tool step followed by a delayed step: the
first step's text and a one-step fold are durable at once, the turn stays streaming through the delay, and
the second step's text arrives in one burst.

```bash
S='[{"text":"Part one: the gate opens onto a courtyard of grey stone.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":50000,"text":"Part two: Lin Feng crosses it slowly and the lanterns bend toward him."}]'
./mf thread send "$T" 'SY go' --no-wait --mock "$S" --json
```

Keep `delayMs` at 50 000 or under. A longer first-chunk wait times the provider call out, the gateway retries,
and the script is spent: the reply then ends in the mock's canned "Acknowledged: …" text and the run proves
nothing. Open the browser about 4 s after the send, and read the chat text with
`agent-browser eval "document.querySelector('[role=log]').innerText"`. After a reload or a first open, the log
is empty for a moment until the read lands; wait for text before judging.

**Settled means:** the chat text is the user message, "Part one…", the fold ("1 step"), then "Part two…",
once each, in that order, with no stop button, and it equals `./mf thread view "$T"` (`text:` then
`fold:` then `answer:`).

### SY-01: open a chat whose reply is streaming

- **Setup:** send the script above with `--no-wait`; wait about 4 s.
- **Steps:** open `/p/<projectId>/chats/<T>` in the browser (a fresh tab on the chat).
- **Expect:** at once the user message, "Part one…", "1 step", a streaming dot and a Stop button. When
  the delay ends, "Part two…" appears whole below the fold, with the dot and Stop gone. Nothing is missing
  from the start of either text, nothing repeats, and the settled chat equals `thread view`.
- **Protects:** the join: a read that lands while the turn is running, followed by live frames.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. Part one with the dot and Stop at once, then Part two whole; settled equals `thread view`. Screenshots `SY-01-mid`, `SY-01-end`.

### SY-02: reload mid-reply

- **Setup:** as SY-01; open the chat and let it show "Part one…".
- **Steps:** reload the page. Wait for text, then wait out the delay.
- **Expect:** after the reload the chat shows "Part one…" and "1 step" with the streaming dot (an empty log
  for a moment first is fine), then "Part two…" arrives and the chat is settled, equal to `thread view`.
- **Protects:** the same join from an empty cell: the sync subscribes only from its first read, so nothing replays from 0 into the chat.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. After the reload Part one and the dot, then Part two; settled equals `thread view`. The log is empty for about a second after the reload. Screenshots `SY-02-reload-mid`, `SY-02-end`.

### SY-03: leave the chat and come back mid-reply

- **Setup:** as SY-01, in `T`. Have a second chat to go to.
- **Steps:** with "Part one…" showing, switch to the second chat with the chat switcher (or the browser's
  history); once it has drawn, come back to `T`.
- **Expect:** on return `T` shows "Part one…" and the fold at once (the kept transcript, with no empty log
  or "Loading"), then "Part two…" arrives and the chat settles, equal to `thread view`.
- **Protects:** the join from a cell the store kept: the handler starts above the cell's delivery cursor, after the mount read, so nothing the cell already shows is delivered twice.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. On return Part one and the fold at once (`SY-03-back`, read immediately after navigating), then Part two; equals `thread view`. Navigation was a client-side history push, not the switcher menu. Screenshot `SY-03-end`.

### SY-03a: leave and come back with the cached read stale

- **Setup:** as SY-03, but the script's first and second steps each carry a tool call (a text-only step ends the mock's reply, so the later steps would never run), so a durable
  block lands while the chat is open and raises the floor past the read Query keeps:
  `S3='[{"text":"Part one: the gate opens onto a courtyard of grey stone.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":3000,"text":"Part two: Lin Feng crosses it slowly.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":50000,"text":"Part three: the lanterns bend toward him."}]'`.
  Send it with `--no-wait`, open `T` and wait for "Part two…" and its fold, then switch to a second chat.
- **Steps:** once the second chat has drawn, come back to `T`.
- **Expect:** on return "Part one…", "Part two…" and the fold at once; "Part three…" arrives after the delay;
  "Part one…" and "Part two…" each appear once, never doubled; the settled chat equals `thread view`.
- **Protects:** a stale cached read is not applied and is not a join; the mount fetch's read joins instead.

### SY-04: another client sends into a chat the browser has open

- **Setup:** `T` with one finished exchange (`./mf thread send "$T" 'SY-04 opener'`). Open it in the browser.
- **Steps:** with the chat showing, run `./mf thread send "$T" 'SY-04 from mf' --no-wait --mock "$S"`. Do
  not touch the browser.
- **Expect:** without a reload, the new message appears, then "Part one…" and the fold with the dot; when the
  delay ends, "Part two…" whole. The opener's exchange is unchanged. Settled, the chat equals `thread view`.
- **Protects:** a missing writer message (a gap read finds it) and the replay fence; this is TL-MF-21's bug,
  a reply that lost its prefix when the message arrived from another client.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. The message, Part one and the dot appeared with no reload; Part two followed; the opener was unchanged; equals `thread view`. Screenshots `SY-04-mid`, `SY-04-end`.

### SY-05: Stop a streaming reply

- **Setup:** as SY-01; open the chat, wait for "Part one…" and the Stop button.
- **Steps:** before pressing, install a sampler in the page that records each distinct state of the log text
  and of `[data-composer-stop]` (a `MutationObserver` on `document.body`). Press Stop (`[data-composer-stop]`,
  which runs through `useChatStop` and the shared operation). Watch about 10 s.
- **Expect:** the Stop button goes and the reply shows its action row (Copy, Fork, Hand off) in place of the
  dot, with "Part one…" kept and no "Part two…". The sampler shows one change, Stop present to Stop absent,
  and no state in which the dot returns, or the reply reads complete or streaming again. `thread view` reads
  `(cancelled)` with `text:` and `fold:` only. The Stopped status reaches the browser by a frame or by a read;
  the recipe doesn't depend on which.
- **Protects:** turn end and terminal status: a status that came from the frame is not undone by the reads
  that follow.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. The sampler recorded one change, Stop present to absent; no dot, complete or streaming state returned in 10 s; `thread view` reads `(cancelled)`. Screenshots `SY-05-before`, `SY-05-after-stop`. The app draws no "Stopped" word; the evidence is the action row and the absent Stop button. `data-chat-turn-row` reads `settled` for a streaming reply too, so it is no status signal.

### SY-06: a write-mode switch queued behind another client's message

- **Setup:** `./mf thread send "$T" 'SY-06 first' --no-wait --mock "$S"` (use a 40 000 ms delay), then
  `./mf thread send "$T" 'SY-06 second from mf' --no-wait`. Open the chat: "SY-06 second from mf" is queued.
- **Steps:** in the composer, open the write-mode control (`AI write mode: Auto-apply`) and choose Draft. Wait
  for the first reply and the second's to end. Then send `./mf thread send "$T" 'SY-06 third'`.
- **Expect:** while the first reply runs, "Switch to draft mode queued" with Stop sits at the tail below the
  queued message. After the second message's reply ends it reads "Switched to draft mode" at the tail, still
  pending. After the third message, the divider "Switched to draft mode" sits between "SY-06 third" and its
  reply, never above "SY-06 second from mf" and never lost. `./mf thread view "$T"` shows the same order
  (`write mode: draft` after `you: SY-06 third`).
- **Protects:** the held divider's anchor: a divider whose anchor message has not yet arrived waits for it, and
  a read must not drop or move it.
- **Note:** the mock's reply echoes the switch notice text; that is the mock, not a defect.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. "Switch to draft mode queued" at the tail while queued; "Switched to draft mode" pending at the tail after the second reply; after the third message the divider sat between it and its reply, matching `thread view`. Screenshots `SY-06-queued`, `SY-06-end`, `SY-06-third`.

### SY-07: the network drops mid-reply and comes back

- **Setup:** as SY-01, with a 35 000 ms delay; open the chat and see "Part one…".
- **Steps:** `agent-browser set offline on`. Wait until the delay has passed (the reply has ended on the
  server). Confirm the browser still shows the streaming dot and a "Connection lost. Retrying…" bar. Then
  `agent-browser set offline off`.
- **Expect:** after reconnecting, within a few seconds the bar goes, "Part two…" appears, and the chat is
  settled, equal to `thread view`.
- **Protects:** the gap read: a socket gap, or the missing frames behind it, recovers from a read.
- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. Offline: the dot stayed, with "Connection lost. Retrying… attempt 7" and no Part two (`SY-07-offline`). Online: Part two within 3 s; equals `thread view` (`SY-07-online`).

### QC-04 baseline

- **Baseline (main `9eb7030cf`, 2026-10-15, mock, desktop):** pass. With "queued 1" queued and "words in tab two"
  typed in the second tab, the x in the first tab put "queued 1" in the first tab's box, removed the row from
  both tabs (`[data-queued]` count 0), and left the second tab's box as typed. `thread view` lists no queued
  row. Screenshots `QC-04-tab2-before`, `QC-04-tab1-after`, `QC-04-tab2-after`. Evidence is in the work
  directory's `evidence/L1a-baseline/`.

A defect in a baseline is one that exists on `main`; a later lane must not make it worse. None was seen. One
staging limit: the mock cannot pace words inside a step, so these recipes cannot show a prefix lost mid-burst.

## Socket replay (SR-01)

Browser checks for the thread socket's replay protocol: each `subscribe` carries a `requestId`, one request is in
flight per thread, and a reconnect sends one `subscribe` per thread (there is no `resume`). They gate any change
under `packages/thread-client/src/socket/` or `apps/server/server/lib/ws-thread-handler.ts`, alongside SY-01 to
SY-07 (the live-sync recipes, written on the thread-sync branch, #883). Run at desktop width with `agent-browser`
on a mock stack as above, look at the screenshots, and judge the screen against `./mf thread view`.

### SR-01: two chats on one socket, offline past the delays, and back

- **Protects:** the reconnect replays every thread, each handler's frames arrive once and in order, and the wire
  carries one `subscribe` per thread on the new socket. A reconnect that replayed only the first thread, or sent a
  batched frame the server handled serially, would leave one chat silent while the connection shows as connected.
- **Setup:** two threads `A` and `B`, each mid-reply (35 000 ms delay, the script of SY-01), started together:

  ```bash
  S='[{"text":"Part one: the gate opens onto a courtyard of grey stone.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":35000,"text":"Part two: Lin Feng crosses it slowly and the lanterns bend toward him."}]'
  ./mf thread send "$A" 'SR go A' --no-wait --mock "$S" --json
  ./mf thread send "$B" 'SR go B' --no-wait --mock "$S" --json
  ```

  No layout subscribes two chats on one socket today (`ChatSurface` is one chat, moved between the center and the
  dock; its three hooks, the sync, `useThreadActivity` and `useThreadDurableProjections`, share one thread's
  subscription). So the browser holds `A` open, and `B` is subscribed through the page's own transport, the
  instance the app created, found from the React tree:

  ```js
  // agent-browser eval, with the chat open on A
  (() => {
    const el = document.querySelector('[role=log]');
    let f = el[Object.keys(el).find((k) => k.startsWith('__reactFiber'))];
    while (f && !(f.memoizedProps?.value?.subscribeCatalog)) f = f.return;
    window.__tr = f.memoizedProps.value;        // the ThreadSocketClient
    window.__B = [];
    window.__unB = window.__tr.subscribe(B_ID, { onEvent: (e) => window.__B.push(e.seq) });
    window.__meridianTrace.clear();             // the debug wire tap
  })()
  ```
- **Steps:** about 5 s after the sends, with "Part one…" showing in the browser, run the script above, then
  `agent-browser set offline on`. Wait 37 s (past both replies' delays and several reconnect attempts; the bar reads
  "Connection lost. Retrying…"). Then `agent-browser set offline off` and wait 5 s.
- **Expect:**
  - `A` shows "Part two…" once, settled, equal to `./mf thread view "$A"`.
  - The wire tap shows two `subscribe` frames, one per thread, on the same new socket and no `resume`:
    `window.__meridianTrace.getEvents({transport:'thread'})` filtered to the client frames and `socket.open` ends
    `socket.open`, `subscribe` (A), `subscribe` (B), on one `socketEpoch`.
  - `B`'s frames equal a fresh full replay: subscribe a second handler with `{ after: '0' }`, wait 3 s, and
    `window.__R` equals `window.__B` (same length, no duplicates, in order). Then release both
    (`window.__unB()`).
- **Not a defect:** the handler errors a handler receives while offline (`WebSocket error`, `WebSocket closed`) are
  connection errors; the replay request itself did not fail.
