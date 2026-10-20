# Scratch before automatic compaction

Run on an owned `MODEL_PROVIDER=mock pnpm dev` stack. Use `./mf` for state and
request inspection, then confirm the transcript in the browser. Mock usage grows
with the request so automatic compaction can be exercised; its synthetic counts
are not provider-performance evidence. Avoid concurrent globally queued scripts.

1. Create a primary mock Agent with an explicit low `autocompact` token trigger
   (12,000 is useful) and a Work chat bound to it. Send a long history message
   (`"The silver gate opens only for the keeper. "` repeated 1,400 times), with
   a short scripted response. A first request alone cannot open the update step.
2. Queue a script with `./mf mock script` **without a match filter**: the optional
   update response, a summary response, and a resumed reply. Rolling summary
   prompts replace the latest user text, so `send --mock`'s match is unsuitable
   for scripting the whole sequence. Send a short next message.
3. Zero-call variant: first step is plain text saying Scratch is current. Inspect
   the snapshot and captured model requests: exactly one `compaction_notes`
   marker, no tool calls, a completed compaction and resumed reply.
4. Batch variant: first step calls two Scratch writes and `ls scratch://`, then
   a fourth Scratch write. Only the first three execute. The fourth has typed
   `{refusal:"notes_step"}`, `isError:false`, explicit not-run output, and no
   document. It must not be elided as a successful edit in the compacted request
   or `thread_history`, nor shown as a green write receipt in the browser.
5. Sequential variant: one Scratch tool per response, three responses. The next
   call is the summary, not a fourth optional model iteration.
6. Failed/held variant: missing Scratch read, manuscript write, Scratch listing,
   fourth Scratch write. The failed read and out-of-scope write consume attempts;
   both writes stay unexecuted. Try forbidden protocol tools (`spawn`,
   `return_result`) too: neutral rows, no child/report side effects.
7. Manual compaction and provider `context_overflow` go directly to summary,
   without an optional marker. Oversized tool results end an admitted step.
   Stop during the optional model response: no summary runs afterward. Retry or
   process recovery must not reopen three calls after a committed marker.
   Exercise a retained Scratch tool group larger than the auto trigger but below
   the actual usable model window: summary and continuation must still run.
   With one shared tree turn left, skip optional maintenance and spend it on the
   post-summary reply. With two left, one optional response may run, then summary
   and reply; there is no renewed allowance when only one remains.
8. Read the marker: it requests shared working-state updates only if useful,
   not a handoff file. List Scratch after each run: no automatic `.handoffs`,
   `handoff.md`, chat folders or copied notes.

Verify ownership independently: another chat in the same Work sees the same
Scratch; independent No Work chats do not; a No Work fork and subagent share
the source lineage; an actual handoff starts a new lineage. Rebinding moves no
notes. Complete [the Files browser checks](chat-uploads-menu.md) on desktop and
phone and capture the compaction/held rows after reloading the chat.

Cold ordering: script a held `return_result` or `spawn` followed by prose in the
same model response. After reload, the paired call must appear once as neutral
Not run before compaction, never as a report or a hidden call. Ordinary failed
`return_result` calls separated from their result by prose retain their reason.
