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
5. **Stop spares a run that took on a later message.** Start the stack with
   `HOOK_PAUSE_AT=ask.pending HOOK_PAUSE_FILE=<file>` and create the file. Script
   the first message's reply with a 5 s step before an `ls`, and script a second
   message (`./mf mock script --match`) to call `ask_user`. Send the first with
   `--no-wait`, then the second while the step waits; the same execution takes it
   on and parks on a `pending` ask. Post Stop with
   `./mf thread stop --replay` and a request whose `seenThrough` is the first
   message's seq and `seenExecutionId` is that execution. PASS:
   `cancelledExecutionId` is null and the ask is still `pending`; delete the file
   and the ask opens, the turn is `awaiting_answer`, and answering continues once.

## Browser confirmation

The client lane fills these steps before the combined feature ships:

- [ ] composer takeover, option/text/Skip, countdown, and hidden Stop
- [ ] optimistic receipt and retry after a failed answer send
- [ ] resolution in another tab restores the draft and appends typed text
- [ ] reload while open and reload after resolution
- [ ] stale answer and zero-countdown “Continuing…” state

## Subagents and Stop

A subagent has no `ask_user`: it does its task or stops and reports what is
missing, and its parent carries on. These cases check that path and the wake
fence that keeps a stopped subagent stopped. Save thread ids and refs from
`./mf thread create --json` and `./mf thread list --json`; mock scripts can't
interpolate ids, so write the child's ref (the parent's `cN` plus one, as `pN+1`)
into the parent's script before you send. A parent woken by a report matches
`--match "finished (succeeded)"`.

1. **No `ask_user` for a child.** Spawn a background child and run
   `./mf thread context <child> --view raw --json`. PASS: the request's tools list
   `return_result` and no `ask_user`.
2. **A child that stops.** Script the child to call `return_result` with a summary
   that says what it is missing, and the parent's wake to send that child a
   background `thread_message` with the missing detail. Script the child's re-task
   (match the message text) to report again. PASS: the child's report wakes the
   parent as any report does, the parent's message re-tasks the child, the child
   reports, and the parent's next turn reads it.
3. **The parent asks the writer.** As step 2, but the parent's wake calls its own
   `ask_user`. Answer with `./mf thread answer`. PASS: the parent's continuation
   messages the child, the child continues and reports, and the parent replies.
4. **Stopped while the parent decides.** As step 2, with the parent's wake step
   delayed (`"delayMs":12000`) before its `thread_message`. During the delay run
   `./mf thread stop <child>`. PASS: the message's result is `thread_stopped` ("@pN
   was stopped, so the message wasn't sent."), the child starts no turn (its
   re-task script stays queued in `./mf mock list`), and the parent's turn goes on.
5. **Queued messages go with Stop.** Spawn a background child whose first step
   waits 25 s, and in the same parent reply send it a background `thread_message`.
   While the child runs, `./mf thread stop <child>`. PASS: the child's run ends
   `cancelled`, its inbox row for the message is acknowledged with no turn, the
   child's `spawn_status` is `cancelled` and `wake_fence_at` is set, and no child
   turn starts afterwards.
6. **Turn cancel and Stop on the root.** Give the root two background children
   with 40 s steps, one spawned in an earlier turn. Cancel the later turn with
   `./mf thread cancel "$root" --turn <turn>`. PASS: only that turn's child ends
   `cancelled`. Then press Stop on the root, even while it is idle. PASS: the
   earlier child is cancelled too; Stop ends the whole subtree, and both
   `spawn_status` values read `cancelled`.
7. **Deletion.** In a chat bound to a fresh Work, spawn a background child with a
   40 s step, then delete the Work (`./mf api DELETE /api/works/<id>`). PASS within
   about two seconds: the child's report is `cancelled`, its `spawn_status` reads
   `cancelled`, and no lease or agent row is left. Repeat by trashing a No Work
   chat (`./mf api DELETE /api/threads/<id>`).
8. **A dying sender.** Have a background middle spawn a leaf, then re-task the
   middle with a step that waits 4 s (`delayMs`) before a background
   `thread_message` to the leaf, or before a `spawn`. While it waits, press Stop on
   the root. PASS: the leaf starts no turn and no child appears. To reproduce a
   flagged run in another process, set the middle's
   `thread_run_leases.cancel_requested` instead of pressing Stop. PASS: the call's
   result is `thread_stopped` ("This run was stopped, so nothing was sent or
   started.").
9. **Two requests in one batch.** Script one primary reply with two `ask_user`
   calls. PASS: one ask row exists, the second call's result is
   `one_request_at_a_time`, and the reply ends `awaiting_answer` on the first
   question.
10. **Failed rows.** Expand step 9's reply in the browser. PASS: the refused row
    reads "Couldn't ask a question" and opens to "Only one question can wait for an
    answer at a time, so this one wasn't asked."; under zh it opens to the Chinese
    sentence. A caught exception (`tool_exception`) opens to "Something went wrong
    while running this.", never the exception text. Arguments that aren't JSON
    (`"rawArgs":"{\"command\": \"show\" \"id\"}"` on a `work` call; jsonrepair fixes
    milder breakage) give `tool_arguments_parse` and open to "The assistant called this
    tool with arguments it couldn't use.", never the retry text. A deliberate refusal opens to its
    own message: script `search` with `"scope":"skills://"` and it reads "search
    doesn't cover skills://. Use ls and read."; a call to a tool the agent lacks reads
    "The assistant can't use this tool here.". For a timeout, hold the Work row
    (`SELECT ... FROM works WHERE id = <w> FOR UPDATE` and `pg_sleep(40)` in psql)
    and script `work update` on it: after 30 s the row opens to "This took too long,
    so it was stopped." A stopped subagent's card reads "Stopped" under its name; a
    failed one reads "Failed".
11. **Stop against a Work's tree lock.** In a fresh Work, have chat P spawn a
    background child C; repeat with new Works until C's id sorts below P's. In psql,
    `BEGIN` and lock C (`SELECT id FROM threads WHERE id = '<C>' FOR NO KEY UPDATE`).
    Send `./mf api POST /api/works/<id>/restore` on the live Work, then
    `./mf thread stop <P>`, then `COMMIT`. Repeat with a receipt reversal instead of
    the restore: a chat creates the Work with the `work` tool, and
    `./mf api POST /api/threads/<chat>/context/reverse` undoes that turn
    (`{"direction":"undo","scope":"turn","target":"<turn>"}`). PASS: both calls
    return, and the Postgres log (`docker logs meridian-dev-postgres-1`) has no new
    `deadlock detected`.
12. **An answer the delete skipped.** Put chats X and A in one Work, X's id below
    A's, and have A ask. Make the answer hold its ask row before it takes A's lock
    (a local pause in `resolve`, never committed), then delete the Work while it
    waits, then release it. PASS: the answer gets `not_open`; the ask reads
    `cancelled`/`cancelled`, its turn `cancelled`, its tool result
    `{"cancelled":true}`; A has no undelivered `ask_resolved` row and
    `./mf log --name wake.failed` stays empty.

Stop the owned stack with `pnpm dev --stop`.
