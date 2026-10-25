# Durable questions

This recipe checks a primary chat's question from the model's `ask` call through
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
     "name": "ask",
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

While an ask is open, send a writer message from a second `./mf` process. PASS:
the bubble and pending run-state item persist, but no run starts and no prefix
turn is materialized. Answer the ask. PASS: the continuation starts first from
the tool result; the queued message is adopted at its first safe boundary.

Queue a write-mode switch and a message during the ask. PASS: the continuation
still starts first. The existing switch rule yields at the continuation's first
boundary, and the following run applies the switch.

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
3. Cancel the asking turn, press the settled chat's Stop route, and delete the
   chat in separate runs. PASS: the ask is cancelled, the asking turn is
   cancelled with `{"cancelled":true}`, and no continuation starts.

## Browser confirmation

The client lane fills these steps before the combined feature ships:

- [ ] composer takeover, option/text/Skip, countdown, and hidden Stop
- [ ] optimistic receipt and retry after a failed answer send
- [ ] resolution in another tab restores the draft and appends typed text
- [ ] reload while open and reload after resolution
- [ ] stale answer and zero-countdown “Continuing…” state

Stop the owned stack with `pnpm dev --stop`.
