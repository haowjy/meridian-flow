# Durable questions

This recipe checks a primary chat's question from the model's `ask_user` call through
its continuation. Run it on an owned stack and database with
`MODEL_PROVIDER=mock`. Record the commit, date, routes, and command output in the
active work directory.

## Setup

1. Start the stack with `MODEL_PROVIDER=mock pnpm dev`, then confirm its routes
   with `pnpm portless:list`.
2. Create a project and chat with `./mf`. Save the chat id as `$chat`.
3. Send a scripted reply whose only tool call is:

   ```json
   {
     "name": "ask_user",
     "arguments": {
       "question": "Which point of view should this scene use?",
       "options": [
         { "label": "First person", "description": "Keep the scene intimate." },
         { "label": "Third person", "description": "Show more of the battlefield." }
       ],
       "recommended": "First person"
     }
   }
   ```

   `./mf thread send` exits 6 with `outcome: "unproven"` when the otherwise
   successful reply ends by asking the question. This is expected: the answer,
   and therefore the final continuation, is not proven yet.

4. Run `./mf thread view "$chat" --json --full`. Save the open ask id as
   `$ask`. PASS: the asking turn is `awaiting_answer`, the ask is `open`, the
   chat is asleep and action-required, and no tool-result block exists yet.

## Answers

Run each case from a fresh ask. Script the next mock response to say which tool
result it received.

| Case | Command | Expected tool result |
|---|---|---|
| Option | `./mf thread answer "$chat" --ask "$ask" --option 'Third person'` | `{"answer":"Third person"}` |
| Own words | `./mf thread answer "$chat" --ask "$ask" --text 'Alternate at the scene break'` | `{"answer":"Alternate at the scene break","free_text":true}` |
| Skip | `./mf thread answer "$chat" --ask "$ask" --skip` | `{"answer":null,"skipped":true}` |

PASS for every case: the asking turn becomes complete, its tool use and result
remain on that turn, exactly one new assistant turn continues, and the answer
command prints the resolved ask. Repeat one socket request with the same
`submissionId`; it returns the first resolution without another continuation.

Submit an unknown option, blank text, and an answer to the resolved ask. PASS:
the first two return `invalid_answer`; the stale answer returns `ask_not_open`
with the resolved ask.

## Timeout

Create an ask with a recommended option and leave it open past 270 seconds.
PASS: within one 15-second sweep it expires, receives
`{"answer":"First person","timed_out":true}`, and continues once. Repeat
without `recommended`; the result is `{"answer":null,"timed_out":true}`.

## Queue barrier

The takeover replaces the browser composer, so use a second `./mf` process for
every queued-message step below.

1. While an ask is open, send a writer message with `--no-wait`. PASS: its full
   durable writer turn and pending run-state item exist, and the browser shows
   the bubble as queued, but no model request adopts it. Answer the ask. PASS:
   one continuation adopts the continuation row and queued message together.
   Its first model request orders the `ask_user` tool use, tool result, then queued
   writer message, and produces exactly one reply; the message is acknowledged
   exactly once.
2. Repeat with
   `./mf thread send "$chat" 'Use this chapter' --ref 'manuscript://Chapter 1' --no-wait`.
   PASS: before and after adoption the durable writer turn retains separate text
   and reference blocks, including document identity; the continuation receives
   the reference and its prepared read result rather than flattened link text.
3. On a fresh ask, queue a referenced message and run
   `./mf thread queue hand-back "$chat" --all --full --json`. PASS: `handedBack`
   contains the complete text and reference blocks, the queued bubble disappears,
   and answering the ask does not adopt the handed-back message.
4. Start the ask in draft mode. Queue a switch to direct mode, then send a
   message. The switch can be queued directly with:

   ```sh
   switch_id=$(node -e 'console.log(crypto.randomUUID())')
   ./mf api POST "/api/threads/$chat/controls" \
     --data "{\"id\":\"$switch_id\",\"control\":{\"kind\":\"write_mode\",\"mode\":\"direct\"}}"
   ```

   Answer the ask. PASS: the continuation starts first without the later
   message and yields at its first boundary. The next run applies the
   direct-mode switch before adopting the message; its assistant turn records
   direct mode. Repeat with the modes reversed.

## Restart and crash windows

Use the crash controller described in
[Crash and two processes](crash-and-two-process.md).

1. **Pending ask crash.** Start with
   `HOOK_CRASH_AT=ask.pending HOOK_CRASH_ARM=/tmp/ask-pending-arm`, arm the file,
   and send the scripted ask. PASS after worker restart: stale repair cancels the
   pending ask; it was never published and the chat is not action-required.
2. **Restart while open.** Open an ask, stop only this stack, restart it, then
   answer with `./mf thread answer`. PASS: the original asking turn completes
   and one continuation starts.
3. **Answer committed, wake lost.** Start with
   `HOOK_CRASH_AT=ask.answer.afterCommit HOOK_CRASH_ARM=/tmp/ask-answer-arm`, arm
   the file, then answer. The client may lose its reply. PASS after restart:
   the ask and tool result are resolved, one `ask_resolved` row is consumed, and
   exactly one continuation exists.

## Two claimants and lineage

1. Open the same ask in two tabs. Submit different answers together. PASS: one
   wins; the loser receives `ask_not_open` with the winner's resolution. Repeat
   with an expiry sweep and with the turn-cancel route racing the answer. Only
   one terminal ask state and at most one continuation remain.
2. Try to fork or hand off through an `awaiting_answer` turn. PASS: the request
   is refused with `Answer or skip the question first.`
3. Regenerate the asking turn, edit an earlier message, and branch before the
   asking turn in separate runs. PASS: the abandoned ask is cancelled without a
   tool result because its turn has left the active lineage.
4. Press the settled chat's Stop route, archive the chat, and delete the chat in
   separate runs. PASS: the ask is cancelled, the asking turn is cancelled with
   `{"cancelled":true}`, the receipt reads “withdrawn,” and no continuation
   starts.

## Browser confirmation

The client lane fills these steps before the combined feature ships:

- [ ] composer takeover, option/text/Skip, countdown, and hidden Stop
- [ ] optimistic receipt and retry after a failed answer send
- [ ] resolution in another tab restores the draft and appends typed text
- [ ] reload while open and reload after resolution
- [ ] stale answer and zero-countdown “Continuing…” state

Stop the owned stack with `pnpm dev --stop`.

## Subagent questions

Use fresh child runs for each case and inspect both chats after every step. Save
child refs and ask ids from `./mf thread view <thread> --json --full`; mock
scripts cannot interpolate the ids returned by an earlier tool call.

1. Have a foreground child call `ask_user`. PASS: the parent call returns
   `@child asks (ask …)` and the parent inbox has no duplicate. Answer with a
   foreground `thread_message`. The child receives a `parent` tool result and
   the original parent card finishes with the continuation's report.
2. Have a background child ask. PASS: the durable question wakes an idle
   parent. Answer from the child chat as the writer, then repeat by leaving the
   question to its deadline. Both continuations report to the original card;
   only the child chat is action-required.
3. Forward an open child question with `ask_user({"forward":"$childAsk"})`. Answer
   before the child deadline. PASS: the parent continuation waits for the child
   and sees one enriched result with `relayed_to` and `report`.
4. Repeat after forcing the child deadline first. PASS: the parent's later
   answer becomes an ordinary child message and its result says `late: true`.
5. While the forwarded copy remains open, answer in the child chat. Have the
   child's continuation ask a new question before answering the forwarded copy.
   PASS: the eventual forwarded answer is late, remains bound to the old ask,
   and does not answer the new one. Repeat with three levels of children; each
   parent owns one question and relays one level down.
6. Race a parent answer with a writer answer in the child chat. PASS: one answer
   wins. The losing parent text remains an ordinary queued message with its
   original ask binding.
7. Forward a descendant's question so the root also has an open ask. Cancel the
   root asking turn with `./mf thread cancel "$root" --turn "$rootAskingTurn"`.
   PASS: every open ask in the subtrees that turn's execution spawned becomes
   cancelled, including children absent from the live session map, each parked
   child's card and `spawn_status` read cancelled, and no continuation starts. A
   background child spawned in an earlier root turn keeps its open question.
   Then press Stop on the root, even while it is idle. PASS: that earlier child is
   cancelled too; Stop ends the whole subtree.
8. Hold a background child's continuation with a slow mock step. PASS: the same
   parent card moves from “Asked a question” while the ask is open, to running
   as soon as the continuation starts, to its final outcome. The primary chat
   never becomes action-required for the child question.
9. Open a forwarded question in the primary chat at 390 px wide. PASS: the
   takeover attributes the question as `@child asks: …`; the options, own-answer
   field, Skip and countdown remain usable.
10. Park a middle child on a question while its background leaf runs a 40 s mock
    step, then press Stop on the root. PASS within about two seconds: the leaf's
    report is `cancelled`, the middle's ask is cancelled, both cards and
    `spawn_status` read cancelled, the middle's inbox has no pending notice, and
    no middle turn starts after Stop. Repeat with a middle that finishes instead
    of asking: its running and parked leaves end the same way.
11. Crash windows. Start the stack with
    `HOOK_CRASH_AT=ask.parentAnswer.afterCommit HOOK_CRASH_ARM=<file>`, arm it,
    and answer a forwarded question. PASS after the worker restarts: the child's
    `direct` `ask_resolved` row is still there, the relay replays, and the parent's
    result carries the child's continuation report. Separately, `kill -9` the
    server while that child continuation runs, then restart the stack with the
    same environment (`pnpm dev:restart` drops it). PASS: the continuation settles
    `failed` (`orphaned`), and the parent's replayed relay carries that report.
12. Redelivery. Set a consumed `ask_resolved` row back to undelivered
    (`UPDATE thread_inbox_messages SET delivered_at = NULL WHERE id = …`), for a
    plain child question and for a forwarded middle. PASS: the wake sweep admits a
    second continuation report for the same ask, acknowledges the row, emits no
    `wake.failed`, and a later writer message to that child still runs.
13. Cancel during a relay. Have the root forward a background child's question
    whose continuation holds a 35 s mock step, answer the root's copy, and once the
    child continuation runs press Stop on the root. PASS: the root's `ask_resolved`
    row is acknowledged, both turns end `cancelled`, and no root turn starts in the
    next 10 s. Repeat with `./mf thread cancel "$root" --turn <relaying turn>`.
    Then launch the answer and Stop together, Stop 0–100 ms later, at least ten
    times. PASS each time: no turn stays streaming and no agent row stays pending.
    When the child's ask is answered with no continuation report, its card and
    `spawn_status` read cancelled, and a full restart starts no turn. A run whose
    Stop request names no execution (it reached the server before the
    continuation started) spares that continuation, which relays and replies.
    Finally repeat step 7's turn cancel with a running 40 s leaf under the middle.
    PASS: no root turn answers the withdrawn `@child asks` notice, and the root's
    ask is the last one cancelled.
14. Deletion. In a chat bound to a fresh Work, spawn a background child with a
    40 s mock step and a background child that asks, then delete the Work
    (`./mf api DELETE /api/works/<id>`). PASS within about two seconds: the slow
    child's report is `cancelled`, the asker's question is cancelled, both
    `spawn_status` read cancelled, and no lease or agent row is left. Repeat by
    trashing a No Work chat (`./mf api DELETE /api/threads/<id>`).
