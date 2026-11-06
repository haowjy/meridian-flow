# Queue controls

Browser checks for the chat queue: the queued look, the x, Cancel queue, Send now and recovery
cards. Any tab's press takes queued messages into its own box, above typed text. Run at desktop
and phone widths in light and dark.

## Setup

Follow [Runtime probes](../../../../../../../docs/qa/README.md): `MODEL_PROVIDER=mock pnpm dev --no-tailscale`,
`pnpm portless:list`, routes that carry this worktree's prefix, `MF_SERVER_URL`
passed explicitly and `MF_APP_URL` as the browser URL. The stack runs with `DEV_AUTH_BYPASS=1`,
so `agent-browser` opens signed in (`--session qc`; a second
`--session qc2` is an independent tab with its own `sessionStorage`). Dark is
`document.documentElement.dataset.uiTheme = 'dark'` through `agent-browser eval`.

`./mf` only sets up and reads durable state. Queue a thread behind a held reply (`T` is a new
thread, `N` the queued count):

```bash
./mf thread send "$T" first --no-wait --mock '[{"text":"Long reply.","delayMs":120000}]'
for i in $(seq $N); do ./mf thread send "$T" "queued $i" --no-wait; sleep 1; done
./mf thread view "$T"      # the queued rows read "(queued)"
```

A queued `/compact` needs a completed reply first (`compact_requires_completed_reply`): send `one`
and wait, then hold the next reply, then type `/compact` and press Enter twice.

Selectors: `[data-queued]` (the article), `[data-queue-control=move-to-box|cancel-queue|send-now]`,
`[data-chat-card=<copy>]` (a card's sentence), `[data-chat-card-action=<try_again|retry>]`
(its action button), `button[aria-label="Dismiss"]` (a refused card's X), `[data-composer-stop]`, and the box at
`[data-composer] .ProseMirror`. A queued command's card sits in its row.

## Fault injection

`agent-browser` cannot drop only a response or hold a request, so install a one-shot
`window.fetch` wrapper with `agent-browser eval` (the app's HTTP client calls the global
`fetch`, `apps/app/src/client/api/http-client.ts`, and `postCommand` in `threads-api.ts`). Match
only the target thread's POST, and leave the WebSocket alone. `$R` is the route suffix
(`hand-back`, `send-now`, `stop`); `T` is the thread id.

- **Lost response** (QC-05, QC-08): the request reaches the server, then rejects.

  ```js
  (()=>{const o=window.fetch;window.__origFetch=o;let used=false;
   window.fetch=async function(u,i){const url=String(u&&u.url||u);
    if(!used&&url.endsWith('/threads/T/R')&&i&&i.method==='POST'){used=true;
     const r=await o.apply(this,arguments);await r.text();throw new TypeError('Failed to fetch');}
    return o.apply(this,arguments)}})()
  ```

- **Hold** (QC-07, and the Send now ring): gate the POST before the real `fetch`, release it with
  a second `eval`.

  ```js
  (()=>{const o=window.fetch;window.__origFetch=o;let used=false;
   window.__gate=new Promise(r=>window.__release=r);
   window.fetch=async function(u,i){const url=String(u&&u.url||u);
    if(!used&&url.endsWith('/threads/T/R')&&i&&i.method==='POST'){used=true;await window.__gate;}
    return o.apply(this,arguments)}})()
  // release: window.__release(); window.fetch=window.__origFetch
  ```

- **Refusal** (QC-08): return `new Response(JSON.stringify({message:'refused'}),{status:409,headers:{'Content-Type':'application/json'}})`
  instead of calling the original. **Dropped request** (a failed Send now, a failed withdraw):
  `throw new TypeError('Failed to fetch')` before calling the original.
- Restore with `window.fetch = window.__origFetch` before pressing Try again.
- **Full storage:** fill this tab's `sessionStorage` with `'x'.repeat(size)` under `__fill<n>`
  keys, halving `size` on each `QuotaExceededError`, until nothing more fits. Free it by removing
  the `__fill*` keys.

## QC-01: the look

Queue three messages. Each row has a dotted border, no fill and muted text, and its chips and links
stay legible (add a reference to one). No line sits under a row: the x is beside each bubble, centred on it, and the article's accessible name is "Your message, queued". A long message wraps with the x still beside it, no overflow at 390 px. When the reply
ends (or Send now), the rows return to the normal bubble: no `data-queued`.

## QC-02: the x

Type words in the box, press the x on the middle row. The row leaves at once, and its words land
above the typed text as one editable block. `./mf thread view` no longer lists it.

## QC-03: Cancel queue

With three queued and words typed, Cancel queue (under the last row, right-aligned with the bubbles, two or more queued). The three
messages come back in send order, blank lines between them, above the typed text. No `[data-queued]`
rows remain.

## QC-04: two tabs

Open the chat in `qc` and `qc2`, with a message queued and words typed in `qc2`. Press the x in
`qc`. The words land in `qc`'s box, the row leaves both tabs, and `qc2`'s box is unchanged.

## QC-05: reload after a lost answer

Install the lost-response wrapper for `hand-back`, press Cancel queue. The server committed, the
`messages.handed_back` frame removes the rows, and the card "Couldn't move your queued messages to
the message box." with Try again sits above the box. Reload: the draft's stored command replays,
the words arrive in the box exactly once, and the card is gone.

## QC-06: Send now

- **Basic:** Send now with two queued. The reply is cancelled, the next reply answers both queued
  messages in order, the box is unchanged and no card shows. A mock reply that has streamed no text
  has no partial to keep; use one that has streamed to see it kept.
- **Ring:** hold the `send-now` POST. The button shows a spinner and is disabled (`data-busy`).
- **Racing Stop:** hold `send-now`, press Send now, then Stop, then release. Stop's hand-back won:
  the words are in the box once, the held Send now shows no card. For the other order press Send now
  first and release before Stop; the queue runs next.
- **Replay after settlement** (needs `./mf thread queue send-now --replay`): replaying the
  printed body after the next reply started prints "this attempt requested no cancellation" and
  does not cancel the next reply.
- **Compaction holding the queue** (needs a start-time compaction): Send now answers null, and the
  compaction and its reply go on.

## QC-07: too late, controlled

Send `first` with a mock script that delays, then calls a tool (`[{"delayMs":30000,"toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"text":"Answered."}]`),
and queue `late 1`. Hold the `hand-back` POST, press the x, wait until `./mf thread view` shows
`late 1` no longer queued (the tool boundary adopted it), then release. The row comes back as an
ordinary message the reply answers, the box is empty, and no card shows.

## QC-08: queue-specific failure cards

Use [Failure cards](failure-cards.md) for shared card and live-region cases. Keep
the queue-specific paths here: drop `send-now` and expect "Couldn't send now."
with Try again or Dismiss; drop `stop` and expect "Couldn't stop the reply."
with Try again; and drop a queued `/compact` row's `withdraw` request and expect
"Couldn't stop the compaction." with Try again in that row. Restore `fetch` and
confirm each retry completes once and removes its card.
