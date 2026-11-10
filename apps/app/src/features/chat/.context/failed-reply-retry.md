# Failed-reply Retry

Nothing retries a failed reply in the background, so the writer retries it from the
reply itself. Card copy and lifetimes are in the
[Chat Failures catalog](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/chat-failures.md#chat-cards);
what forgetting does is in
[A Failed Attempt Is Forgotten](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/turns.md).

## Who decides

`chatMovedPast` in `@meridian/thread-client/view` is the one reader of "latest":
no closing turn (`isClosingRow`, drawn or not) follows the reply, so a divider
counts and so does an agent's message, which draws no row. `viewTranscript` decides
whether an older failed reply has a row, keeping one a card is anchored on
(`anchoredTurnIds`).

The client doesn't gate Retry on the chat being busy: whatever runs next takes its
Retry away, and the server refuses a Retry that races a run with a 409.

Provider classification never reads `turn.error` text. A decline is
`metadata.retryable === false` with `metadata.providerError` (`isProviderDeclined`).
It still offers Retry, which may succeed once the cause is fixed.

An inherited failed reply stays read-only. An unadmitted message's "Couldn't send."
Retry belongs to the writer row, not here.

## Retry, optimistically

`useReplyRetry.ts` mints the new reply's id and puts a working reply below the
failed one at once. The failed reply stops being drawn but stays in the store. The
response's turn replaces the stand-in by id, and the store's turn replaces that.

- **Refused** (409 `reply_retry_unavailable`, or `runtime_shutting_down`). Nothing
  was written. The stand-in goes, the snapshot refreshes, and the failed reply
  carries a generic refused card; the cause reaches `FailureLog`, not the writer. A
  completing reply clears it: `useRetryStandIns` records, per refusal, the replies
  already complete, and the card ends when another completes (durable turn status,
  no timers). A row landing below, or a reply that fails or is cancelled, doesn't
  clear it.
- **Lost request.** The entry stays held, failed, but is no stand-in, so the failed
  reply shows again with a card. Try again re-sends the same id. If the lost request
  landed, the server answers with the execution it started, or `retry_pending` (503)
  while it can't tell yet. Pending answers repeat the same id after `Retry-After`, up
  to `RETRY_PENDING_ATTEMPTS`; past that the request is lost again, retryable, never
  refused.
- **Its run ends without the reply.** The stand-in keeps the execution its Retry
  answered and the version of that answer's run-state record. Once the held record,
  at or past that version, shows no execution or another one, nothing will create
  the reply and the stand-in goes. A lost response has no version, so it waits for
  the writer. Placement next to a compaction is never evidence: a mode switch can
  sit between the failed reply and its compaction.

Pressing Retry moves focus to the transcript, because the button leaves with the
error block. A stand-in reads no lineage and live announcements skip it, so a lost
request isn't reported as a failed run.

`reconcileRetries` in `@meridian/thread-client` is the one retirement rule.
`useRetryStandIns.ts` keeps transport and storage for this Retry and the handoff
brief's; each caller supplies the POST and the stand-in's shape. `placeStandIns`
puts a stand-in after the `write_mode_switch` turns that directly follow the failed
reply, while a newer writer message still comes after it.
