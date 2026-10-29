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
       "questions": [
         {
           "question": "Which point of view should this scene use?",
           "options": [
             { "label": "First person", "description": "Keep the scene intimate." },
             { "label": "Third person", "description": "Show more of the battlefield." }
           ],
           "recommended": "First person"
         }
       ]
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
| Option | `./mf thread answer "$chat" --ask "$ask" --answer 'option:Third person'` | `{"answers":[{"question":"Which point of view should this scene use?","answer":"Third person"}]}` |
| Own words | `./mf thread answer "$chat" --ask "$ask" --answer 'text:Alternate at the scene break'` | `{"answers":[{"question":"…","answer":"Alternate at the scene break","free_text":true}]}` |
| Skip | `./mf thread answer "$chat" --ask "$ask" --answer skip` | `{"answers":[{"question":"…","answer":null,"skipped":true}]}` |

Pass one `--answer` per question in order, or all of them as `--answers '<json>'`.

PASS for every case: the asking turn becomes complete, its tool use and result
remain on that turn, exactly one new assistant turn continues, and the answer
command prints the resolved ask. Repeat one socket request with the same
`submissionId`; it returns the first resolution without another continuation.

Submit an unknown option, blank text, too few answers, and an answer to the resolved
ask. PASS: the first three return `invalid_answer` (for an unknown option or blank text the
socket's `ask.answer.error` frame also carries the question's `questionIndex`); the stale answer returns
`ask_not_open` with the resolved ask.

### Several questions

Script `ask_user` with three questions (two with a `recommended`, one without),
then answer `--answer 'option:Third person' --answer 'text:About 2000 words' --answer skip`.
PASS: `./mf thread view "$chat"` lists the three questions numbered while open and
shows each with its answer after; the tool result is `{"answers":[…]}` with three
entries in order, each carrying its question text, the second `free_text:true`, the
third `skipped:true`; one continuation. A fourth question is accepted; a fifth, or
none, fails the call's arguments (`invalid_arguments`). A call in the old one-question
shape (`question`, `options` at the top) is still accepted as one question.

## Timeout

A question times out after 4 minutes idle, and never later than 55 minutes after it
opened. The constants are in `asks/ask-deadline.ts`; to run these cases quickly, shorten
them locally (for example 20 s and 60 s), restart the stack with `MODEL_PROVIDER=mock`,
and revert before committing.

1. **Nothing answered.** Open a one-question ask with a `recommended` and wait out the
   idle time. PASS: within one 15-second sweep it expires and receives
   `{"answers":[{"question":"…","answer":"First person","timed_out":true}]}`, and
   continues once. Repeat without `recommended`; the entry is
   `{"answer":null,"timed_out":true}`.
2. **Walk-away after answering some.** Open a three-question ask. Send
   `./mf thread presence "$chat" --answer 'option:Third person' --answer none --answer none`,
   then stop. PASS: after the idle time the ask expires; the first entry is the writer's
   `Third person` (no `timed_out`), the second takes its Recommended option with
   `timed_out:true`, and the third, which has none, is `{"answer":null,"timed_out":true}`.
   `./mf thread view` shows the same.
3. **Presence bumps the deadline.** On an open ask, note `continues at` in
   `./mf thread view`, run `./mf thread presence` (with `--answer none` per question)
   about halfway through the idle time. PASS: `continues at` moves to the idle time after
   the presence. Repeat before each deadline. PASS: the deadline moves each time and stops
   at 55 minutes after the ask opened (`opened_at`); a presence after that moves nothing,
   and the ask expires at the limit, from the held answers.
4. **Refused presence.** Send presence for a chat the signed-in user doesn't own, an
   ask that is already resolved, a permission request, and a draft that names an unknown
   option. PASS: none changes `deadline_at` or `draft_answers`.
5. **Restart.** Send presence with a held answer, restart the stack, and wait out the
   idle time. PASS: the ask still expires on its stored deadline, and the held answer
   stands in the result.

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

Open the chat in the browser with `agent-browser`, at desktop width and at 390 px.

1. **Several questions.** Open the three-question ask from "Several questions". PASS: the
   takeover shows "1 of 3" and the countdown above the question, and no Stop. Picking an
   option moves to the next question; typing your own words and pressing Enter or Next
   moves on; Skip on the last question shows as pressed, and Send answers is enabled
   only once every question has an answer. Back shows each earlier question with its
   answer still chosen or typed.
2. **Countdown follows interaction.** Note `continues at` in `./mf thread view`, pick an
   option, and read it again. PASS: it moved to 4 minutes after the click, and the
   takeover's countdown follows. Typing within 30 seconds sends one more presence when
   the 30 seconds are up, holding the typed words.
3. **Failed send and Retry.** Make the socket drop `ask.answer` frames (wrap
   `WebSocket.prototype.send` in the page) and send. PASS: the receipt shows this
   device's answers with the pending dot at once; after 20 s the takeover returns with
   "Couldn't send your answer.", every answer in place. Let frames through and press
   Retry: the frame carries the same `submissionId`, and the chat continues once.
4. **Receipt.** PASS: a three-question receipt reads "3 questions: 2 answered, 1
   skipped" and expands to each question with its answer. After a walk-away timeout
   (Timeout case 2) it lists the held answers, and "No answer" or "No answer, went
   with …" for the rest.
5. **One question.** Open the one-question ask. PASS: it looks as before (no "1 of 1",
   no Back or Next), and an option, Skip or Enter in the field answers at once. Words
   left in the field when an option is picked, and the composer draft from before the
   ask, are in the composer afterwards.

Still to confirm in the browser: resolution in another tab, reload while open and after
resolution, and the stale answer and zero-countdown "Continuing…" state.

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
   earlier child keeps running and its `spawn_status` still reads `running`; Stop
   ends only the root's own reply. Its report, when it finishes, starts a root
   turn.
   Then stop one from the strip: spawn two background children of the root with
   40 s steps, queue a writer message to each, and press Stop on one child's row in
   the running-subagents bar. PASS: the other child keeps running and its
   `spawn_status` reads `running`; the stopped one is `cancelled`, and its queued
   writer message comes back to that child's composer.
   Then the layout race: with one background child, hold its snapshot read in the
   browser (wrap `fetch` so `/snapshot` requests wait), press its strip Stop, start a
   second child so the strip becomes a list, collapse and expand the list, then
   release the read. PASS: exactly one `/stop` post is sent, the child reads
   Stopped, and its row leaves. Failing the held read instead leaves "Couldn't stop
   the reply." under that row even with the list collapsed.
7. **Deletion.** In a chat bound to a fresh Work, spawn a background child with a
   40 s step, then delete the Work (`./mf api DELETE /api/works/<id>`). PASS within
   about two seconds: the child's report is `cancelled`, its `spawn_status` reads
   `cancelled`, and no lease or agent row is left. Repeat by trashing a No Work
   chat (`./mf api DELETE /api/threads/<id>`).
8. **A dying sender.** Have a background middle spawn a leaf, then re-task the
   middle with a step that waits 4 s (`delayMs`) before a background
   `thread_message` to the leaf, or before a `spawn`. While it waits, press Stop on
   the middle. PASS: the leaf starts no turn and no child appears. To reproduce a
   flagged run in another process, set the middle's
   `thread_run_leases.cancel_requested` instead of pressing Stop. PASS: the call's
   result is `thread_stopped` ("This run was stopped, so nothing was sent or
   started.").
9. **Two requests in one batch.** Script one primary reply with two `ask_user`
   calls, each with a question. PASS: one ask row exists, the second call's result is
   `one_request_at_a_time`, and the reply ends `awaiting_answer` on the first call's
   questions. (Several questions go in one call; see "Several questions".)
10. **Failed rows.** Expand step 9's reply in the browser. PASS: the refused row
    reads "Couldn't ask a question" and opens to "Only one question or request can
    wait for an answer at a time, so this one wasn't asked."; under zh it opens to the Chinese
    sentence. A caught exception (`tool_exception`) opens to "Something went wrong
    while running this.", never the exception text. Arguments that aren't JSON
    (`"rawArgs":"{\"command\": \"show\" \"id\"}"` on a `work` call; jsonrepair fixes
    milder breakage) give `tool_arguments_parse` and open to "The assistant called this
    tool with arguments it couldn't use.", never the retry text. A deliberate refusal opens to its
    own message: script `grep` with `"path":"skills://"` and it reads "grep
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

## Permission requests

No shipped action currently asks. For this probe only, change the `edit`
entries for `work.archive`, `work.update` and `work.write_mode` in
`runtime/loop/permissions/action-policy.ts` from `allow` to `ask`. Do not commit
that patch. `work.delete` can't ask: an `ask` row for it fails to compile.
`./mf thread answer` can't answer a permission request; answer in the browser.
Create two primary chats in one project and a child chat, then exercise these
cases:

1. **Allow.** Ask the first primary chat to archive a Work, then choose Allow.
   PASS: the saved Work id is archived, the asking turn gets the action's real
   result (“Archived …”, with the Work receipt), the receipt says Allowed, and one
   continuation starts.
2. **Rename.** Ask for a rename and Allow it. PASS: the takeover names the Work as
   “name (@handle)” and says the new name; the Work is renamed and the result reads
   “Updated …”.
3. **Allow always.** Repeat with another active Work and choose Allow always.
   Ask the second primary chat to archive a third Work. PASS: it runs without a
   takeover because the project grant applies to `work.archive`.
4. **Deny.** In a project without that grant, choose Deny. PASS: no Work changes,
   the tool result is `{"allowed":false}`, and the receipt says Denied.
5. **Refused action.** Create Works named “Review target” (`w1`) and “Already
   taken” (`w2`), then ask for a rename onto the taken name:

   ```sh
   ./mf thread send <chat> 'Rename probe' --mock \
     '[{"toolCalls":[{"name":"work","args":{"command":"update","work":"w1","name":"Already taken"}}]},{"text":"done"}]'
   ```

   Choose Allow. PASS: the asking turn gets a `work_name_conflict` error tool
   result, the answer is recorded (the takeover clears and no Retry appears),
   neither Work changes, and the continuation sees the error. Archiving an
   already archived Work is not a refusal: it is an idempotent no-op that
   reports the Work as already up to date.
6. **Restart.** Restart this stack while a permission request is open. PASS: it
   remains open without a deadline and answers normally after restart.
7. **Two requests in one response.** Script two asking `work` calls in one
   response, then a question and an asking `work` call in either order:

   ```sh
   ./mf thread send <chat> 'Parallel probe' --mock \
     '[{"toolCalls":[{"name":"work","args":{"command":"archive","work":"w3"}},{"name":"work","args":{"command":"archive","work":"w4"}}]},{"text":"done"}]'
   ```

   PASS: one ask row; the second call's result is `one_request_at_a_time`, and its
   row opens to “Only one question or request can wait for an answer at a time, so
   this one wasn't asked.”; the reply ends `awaiting_answer` on the first request.
8. **Stop.** Stop a chat with an open request. PASS: the ask is `cancelled` and
   nothing changes.
9. **Child without a grant.** Have the child call a patched action the project has
   no grant for. PASS: it receives exactly “Only the main chat can ask the writer to
   allow this change. If your task needs it, stop and say in your report what is
   missing.” No ask is created, and the failed row in the child chat opens to “This
   assistant isn't allowed to make this change, so it wasn't done.” A parent's
   `thread send --mock` script does not reach the child it spawns: queue the
   child's script separately with
   `./mf mock script … --match "<text from the child's prompt>"`.
10. **Child with a grant.** After step 3's Allow always, have the child archive a
    Work. PASS: it runs without a request, as in the main chat.
11. **Write mode.** In an auto-apply chat, script
    `{"name":"work","args":{"command":"write_mode","mode":"draft"}}` and Allow it.
    PASS: the takeover asks to switch this chat to draft mode; the chat's next reply
    runs in draft mode; the queued control row has `agent` provenance; and the Work's
    `default_ai_write_mode` is unchanged, so a new chat in that Work starts in
    auto-apply.

In the browser, confirm permission takeovers have only Deny, Allow always, and
Allow; no text field or countdown appears. Repeat a failed send and a stale
answer from another tab to confirm the same Retry and `ask_not_open` behavior as
questions. Revert the local policy patch before committing.
