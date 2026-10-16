# Chat session recipes

Runtime checks that the chat the browser draws and the chat `./mf` prints are the
same view model. `./mf` reaches the browser's answer to "which rows does the writer
see, and what does each reply show" because both run `viewTranscript` from
`@meridian/thread-client`; this page is where the recipes for the session's commands
will grow, one per command. Today it holds the transcript comparison.

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
