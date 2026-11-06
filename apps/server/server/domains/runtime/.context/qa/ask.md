# Durable questions

This recipe checks a primary chat's `ask_user` call through its continuation.
Run it on an owned `MODEL_PROVIDER=mock pnpm dev` stack.

## Setup

Set `E` to the active work item's evidence directory. Create a project and chat
with `./mf`. Send a scripted reply whose only tool
call asks one question:

```json
{"name":"ask_user","arguments":{"questions":[{"question":"Which point of view should this scene use?","options":[{"label":"First person","description":"Keep the scene intimate."},{"label":"Third person","description":"Show more of the battlefield."}],"recommended":"First person"}]}}
```

Use the JSON as the only mock tool call, then capture the open ask id:

```bash
./mf thread send "$chat" 'Choose the point of view.' --mock '[{"toolCalls":[{"name":"ask_user","args":{"questions":[{"question":"Which point of view should this scene use?","options":[{"label":"First person","description":"Keep the scene intimate."},{"label":"Third person","description":"Show more of the battlefield."}],"recommended":"First person"}]}}}]' --json > "$E/ask.ndjson"
./mf thread view "$chat" --json --full > "$E/open.json"
ask=$(jq -r '.. | objects | select(.status? == "open") | .id' "$E/open.json" | head -1)
```

`./mf thread send` exits 6 with `outcome: "unproven"` while the answer is
missing. In `./mf thread view "$chat" --json --full`, the asking turn is
`awaiting_answer`, the ask is `open`, the chat is asleep and action-required,
and no tool-result block exists.

## Answers

From a fresh ask, run each command and script the continuation to report its
tool result:

```bash
./mf thread answer "$chat" --ask "$ask" --answer 'option:Third person'
./mf thread answer "$chat" --ask "$ask" --answer 'text:Alternate at the scene break'
./mf thread answer "$chat" --ask "$ask" --answer skip
```

Each answer completes the asking turn, leaves the tool use and result on that
turn, starts exactly one assistant continuation, and prints the resolved ask.
Replay the same `submissionId`; it returns the first resolution without another
continuation. Unknown options, blank text, too few answers and a stale answer
return `invalid_answer` or `ask_not_open` without changing the ask.

For three questions, answer an option, free text and skip in order. The view
lists all three while open and the result has three ordered entries with
`free_text` and `skipped` markers where applicable. A fourth question is
accepted; an over-limit request is rejected with `invalid_arguments`.

## Timeout

An ask expires after four minutes idle and no later than 55 minutes after it
opened. To run quickly, shorten those constants locally, restart the mock
stack, and revert the local change before finishing.

1. Let a one-question ask expire with and without a recommendation. The result
   uses the recommendation with `timed_out: true`, or `answer: null` when
   none exists, and one continuation starts.
2. In a three-question ask, send presence with one chosen answer, one empty
   answer and one empty answer, then wait. The chosen answer stays without a
   timeout marker; the recommended answer and unanswered question carry
   `timed_out: true`. Unsent typed words are `unsent_text`, not an answer.
3. Send presence halfway through the idle period. `continues at` moves forward;
   presence after the 55-minute limit does not move it. A refused presence for
   a foreign, resolved or invalid ask leaves `deadline_at` and `draft_answers`
   unchanged and logs `ask.presence.refused`.
4. Restart with a held answer. The ask keeps its stored deadline and answer,
   then expires normally.

## Queue barrier

While an ask is open, send a writer message with `--no-wait`. Its durable turn
and pending run-state item exist, the browser shows a queued bubble, and no
model request adopts it. Answer the ask: one continuation adopts the ask result
and queued message, then produces one reply.

Repeat with `--ref 'manuscript://Chapter 1'`. Text and reference blocks remain
separate before and after adoption, including document identity. Hand back a
queued referenced message with `./mf thread queue hand-back "$chat" --all
--full --json`; it disappears from the queue and is not adopted by the answer.

In a draft-mode ask, queue a direct-mode control, then send a message. Answer
the ask: the continuation starts before the later message, and the next run
applies the mode switch before adopting it. The assistant turn records direct
mode.

Queue the control through the existing route so its ordering is reproducible:

```bash
switch_id=$(node -p 'crypto.randomUUID()')
./mf api POST "/api/threads/$chat/controls" \
  --data "{\"id\":\"$switch_id\",\"control\":{\"kind\":\"write_mode\",\"mode\":\"direct\"}}"
./mf thread send "$chat" 'Use this chapter' --ref 'manuscript://Chapter 1' --no-wait --json
```

## Restart and crash windows

Use the crash controller with an armed file while starting an ask:

```bash
ARM=/tmp/ask-pending-arm; : > "$ARM"
HOOK_CRASH_AT=ask.pending HOOK_CRASH_ARM="$ARM" pnpm dev --no-tailscale
```

After worker restart, stale repair cancels the uncommitted ask and the chat is
not action-required. For the committed-answer window, arm
`HOOK_CRASH_AT=ask.answer.afterCommit`, answer the open ask, restart, and inspect
`./mf thread view "$chat" --json --full`: the ask and tool result are resolved,
one `ask_resolved` row is consumed, and one continuation exists.

Restart with an ask open, answer it, and expect one continuation. A restart
while open preserves the stored deadline and the answer still completes once.

## Two claimants and lineage

Submit different answers from two tabs. One wins; the other receives
`ask_not_open` with the winning resolution. Repeat with expiry and turn-cancel
races; only one terminal ask and at most one continuation remain.

Forking or handing off an `awaiting_answer` turn returns “Answer or skip the
question first.” Regenerating the asking turn, editing an earlier message or
branching before it cancels the abandoned ask without a tool result. Stop,
archive and delete cancel the ask and its asking turn, record a withdrawn
receipt and start no continuation.

Stop a running execution that has adopted a later message but is paused at a
pending ask. The Stop request must leave `cancelledExecutionId: null` and the
ask pending; release the pause and answer once.

## Browser confirmation

At desktop and 390px phone widths, confirm these five checks:

1. Three questions show “1 of 3” and a countdown, move through option, free
   text and Skip, preserve earlier answers with Back, and enable Send answers
   only when every question is answered.
2. Activity moves the countdown and preserves held answers; unsent words after
   timeout return to the composer as “Not sent: …”. A new question has no stale
   focus ring.
3. Drop `ask.answer` frames with a page wrapper:

   ```js
   const send0 = WebSocket.prototype.send;
   WebSocket.prototype.send = function (raw) {
     const frame = JSON.parse(raw);
     if (frame.type === "ask.answer") return;
     return send0.call(this, raw);
   };
   ```

   The device shows its answers immediately, then “Couldn't send your answer.”
   with Retry. Restore `send0`; Retry uses the same `submissionId` and continues
   once.
4. The receipt reports answered, skipped and unsent entries and expands to each
   question. Reloading is silent; resolution from another tab converges.
5. A one-question ask has no “1 of 1”, Back or Next. Option, Skip or Enter
   answers immediately, and prior composer words return afterward.

## Subagents and Stop

A child cannot call `ask_user`; it reports what is missing and its parent
continues. Spawn a background child and inspect its request: tools include
`return_result` and not `ask_user`.

Have a child report, let the parent message it with missing detail, and confirm
the child reports again. If the parent asks the writer, answer it and confirm
the child continues. Stop the child while the parent is deciding: the message
result is `thread_stopped`, the child starts no turn, and the queued re-task
remains queued. Stop a child with queued messages: its run is `cancelled`, its
inbox rows are acknowledged without a turn, `spawn_status` is `cancelled`, and
the wake fence prevents a later turn.
