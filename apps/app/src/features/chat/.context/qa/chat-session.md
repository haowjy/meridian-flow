# Chat session recipes

These checks compare the browser's chat with `./mf thread view` and exercise
the live sync shared by the app and CLI. Use an owned mock stack, one named
`agent-browser` session, and `./mf thread view` as the durable transcript.

## Compare a chat in the browser with `./mf thread view`

Create a chat with a writer message, a tool call, a background report and a
compaction. Open `/p/<projectId>/chats/<threadId>` and scroll every row into
view, expanding every process fold before comparing.

Compare rows in order by `identity.turnId`, `identity.kind` and
`identity.occurrence`; the DOM carries the turn id as `data-turn-id` and the
kind as `data-chat-turn-kind`. Compare render-item kinds through
`data-turn-item-kind` (`process`, `text`, `report`, `artifact`, `delivery`) and
visible text after whitespace normalization and reference-title rendering.
Compare fold tools by `runs[].tools[].name` and `input`, reports by `summary`,
handoff rows by `brief`, and delivery groups by child, title and outcome.

Do not compare React `renderKey`. It may change when a local turn receives its
server id. The browser may additionally show local Retry/unsent records,
background report bodies, inherited fork history, receipt rows
and card presentation text; compare those only with their durable source when
the source exists.

Expect the same settled rows, order, item kinds, fold contents and normalized
text. A fold whose `visible` is false is absent from the DOM. A reply with
`continuing: true` has no action row.

## Live sync (SY-01 to SY-07)

Use a 1280px browser and a fresh thread. Stage a mid-reply mock with a durable
text/tool step followed by a delayed text step:

```bash
S='[{"text":"Part one: the gate opens onto a courtyard of grey stone.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":50000,"text":"Part two: Lin Feng crosses it slowly and the lanterns bend toward him."}]'
./mf thread send "$T" 'SY go' --no-wait --mock "$S" --json
```

Open the chat about four seconds after sending. The first text and one-step
fold should already be visible; wait for the second text before judging a
settled result. A longer first-chunk delay times out the mock call.

### SY-01: open a chat whose reply is streaming

Open the chat in a fresh tab while the first step is visible. Expect the user
message, first text, fold, streaming dot and Stop at once. When the delay ends,
the second text appears once, the dot and Stop disappear, and the result equals
`thread view`.

### SY-02: reload mid-reply

Reload while the first text is visible. After the read lands, the first text,
fold and streaming dot remain; the second text arrives once and the settled
chat equals `thread view`.

### SY-03: leave and return mid-reply

Switch to another chat while the first text is visible, then return. The first
text and fold are already present without a duplicate or loading replacement;
the second text arrives once.

### SY-03a: return with a stale cached read

Use tool calls on the first and second mock steps so the second step is durable
while the chat is open. Leave after the second text and return. The first and
second texts and their folds appear once; the delayed third text arrives once.

### SY-04: another client sends into an open chat

With the chat open, run `./mf thread send "$T" 'from mf' --no-wait --mock "$S"`.
The new message, first text and fold appear without reload, followed by the
second text. The opener remains unchanged and the settled view matches.

### SY-05: Stop a streaming reply

Install a `MutationObserver` for the log and `[data-composer-stop]`, then press
Stop while the first text and dot are visible. The action row replaces the dot,
the first text remains, the second never appears, and Stop never returns.
`thread view` reports `(cancelled)` with the text and fold.

### SY-06: a write-mode switch queued behind another client's message

Hold a first reply, send a second message from `./mf`, and choose Draft in the
browser. The queued switch notice sits below the queued message. After the
second reply ends, the applied notice stays pending until the next message;
then its divider sits between the third message and its reply. It never moves
above the queued message. `thread view` shows the same order and draft mode.

### Write-mode switch order

Use the same delayed reply and repeat the switch at idle, during a reply, in
two tabs and on a 390px phone viewport.

- At idle, the control changes immediately and a quiet “Switched to …” notice
  sits at the tail. Reload and open a second tab; both show it. Switch back
  before sending and confirm the notice disappears without a turn. Send first
  instead; the notice becomes the transcript line after that message.
- During a reply, the queued notice sits at the tail with Stop. After the reply
  ends it becomes “Switched to …” and remains pending until the next reply;
  Stop removes it. Switching and switching back leaves no control row.
- Abort `**/controls`, switch, then send. The switch row shows “Couldn't
  switch…” with Retry and no Stop while the message remains Sending. Restore
  the route and Retry; the switch queues and can be stopped. Reloading instead
  admits the switch before the message.
- In two tabs, the other tab sees the queued mode and can Stop it. A hidden tab
  whose control response is held converges on the queued row when a visible tab
  drives it. Sample the row, Stop and toolbar label while the reply ends; no
  frame may show neither the row nor its applied divider, and the toolbar never
  returns to the old mode.
- Refuse the first New-chat send with a queued switch. Edit returns the message
  and its draft to New chat and clears the switch. A new chat starts in the
  selected mode. Two chats in one Work use the Work default after a switch; a
  switch turn ends an earlier steer continuation.
- With two named browser sessions, choose opposite modes during a slow reply.
  Both sessions converge on the winning queued row, the inbox holds only the
  message, and the toolbar does not revert. The live region announces a switch
  once, stays silent on reload and apply, and clears a failed-switch sentence
  on Retry or Stop. A delayed control response still leaves the applied mode
  and transcript turn in place. Draft count reads “Drafts (2)” for two waiting
  document drafts and “Draft” for none.

### SY-07: the network drops mid-reply and returns

With the first text visible, run `agent-browser set offline on` until the server
has finished the delayed step. The browser keeps the dot and shows
“Reconnecting…”, then “Offline” with Reconnect now, on a line inside the composer; nothing
outside the composer moves. Run `agent-browser set offline off`; the line goes,
the second text appears, and the settled chat matches `thread view`.

## Socket replay (SR-01)

Open two chats on one named browser session, set the browser offline past the
replay delay, send one message to each from `./mf`, then reconnect. Each chat
replays its own missing rows exactly once, preserves order, and settles to its
`thread view`; no cross-chat event appears.

### Warm-cache replay over 500 events

The basic case above proves two chats recover on one socket. Run this larger
case to force the warm event cache to fall back to the journal:

```bash
CHECK_ID="replay-seek-$(date +%s)"
PROBE_DIR="$(mktemp -d "/tmp/$CHECK_ID.XXXXXX")"
./mf thread create --title "$CHECK_ID" --json > "$PROBE_DIR/chat.json"
T="$(jq -r .threadId "$PROBE_DIR/chat.json")"; P="$(jq -r .projectId "$PROBE_DIR/chat.json")"
./mf thread send "$T" seed --mock '[{"text":"Earlier completed reply."}]' --json
./mf thread tail "$T" --timeout 5m --json > "$PROBE_DIR/tail.jsonl" & TAIL_PID=$!
agent-browser --session "$CHECK_ID" open "$MF_APP_URL/p/$P/chats/$T"
agent-browser --session "$CHECK_ID" wait --text "Earlier completed reply."
agent-browser --session "$CHECK_ID" set offline on
node -e 'console.log(JSON.stringify([{text:"After disconnect, part one.",toolCalls:[{name:"thread_ls",args:{depth:1}}]},{text:"SEEK_START "+Array.from({length:750},(_,i)=>"seek"+i).join(" ")+" SEEK_END"}]))' > "$PROBE_DIR/mock.json"
./mf thread send "$T" "Send while browser is offline" --mock "@$PROBE_DIR/mock.json" --json > "$PROBE_DIR/send.jsonl"
agent-browser --session "$CHECK_ID" set offline off
agent-browser --session "$CHECK_ID" wait --text "SEEK_END"
agent-browser --session "$CHECK_ID" eval '(() => { const text=document.querySelector("[role=log]").innerText; const words=text.match(/\bseek\d+\b/g)??[]; return {count:words.length,unique:new Set(words).size,ordered:words.every((w,i)=>w==="seek"+i),starts:(text.match(/SEEK_START/g)??[]).length,ends:(text.match(/SEEK_END/g)??[]).length}; })()'
./mf thread view "$T" --full --json > "$PROBE_DIR/view.json"
kill "$TAIL_PID" 2>/dev/null || true
```

Expect 750 words, 750 unique words, ordered `seek0` through `seek749`, and one
start and end marker. The durable `finalText` has the same sequence, the fold
has one `thread_ls` item, and a later composer message still replies normally.

### Subscribe at the head without losing durable state

With a settled reply, a document write and a named Work binding, subscribe once
without a cursor and once with `lastSeq: "0"`. The cursorless acknowledgment's
`after` is the current head and has no catch-up; the zero-cursor subscription
replays the durable suffix. A saved nonzero cursor returns exactly the suffix
after that cursor, and an empty chat acknowledges `after: "0"`.

Attach a cursorless and explicit-cursor handler before the first acknowledgment.
The explicit join replaces the cursorless request; delayed acknowledgments must
still deliver the required backlog and live frames once, in sequence order.
Hold or reject the head read, then unsubscribe or replace it. The old request
must not acquire a listener or emit an acknowledgment; a current read failure is
retryable and a later request succeeds. A 64-character request id succeeds;
empty and 65-character ids return `bad_request` without mutating the target.

In the browser, hold the target subscribe, finish a document write, and rebind
the chat to a Work from another client. Release the subscribe: the receipt and Work
name appear without reload. Reconnect and send again; settled
text, child activity and tools do not duplicate.
