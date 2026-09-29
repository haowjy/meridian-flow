# Failed-reply Retry

A failed reply consumes the messages it answered, and nothing retries it in
the background (boundary-work Amendment A5). So the writer retries it from the
reply itself.

## What the writer sees

| Failed reply | Row |
|---|---|
| Latest turn, chat idle | Tinted block: "This response failed." with **Retry** beside it |
| Latest turn, chat busy | Retry stays in place, `aria-disabled`, described by "You can retry when this chat is free." |
| Not the latest turn | The quiet line "This response failed.", with no action |
| Its Retry was refused | Adds the muted note "Couldn't retry.", current or in history |

"Latest" is `endsTranscript` in `TurnList`: no visible row follows, and a
divider counts as a row. Busy is the same signal the brief card's Retry uses:
the live status is awake, or the composer has a run. The server's 409 covers
the race. A failed first send (`failedSendRetry`) keeps its own "Couldn't
send." Retry, and an inherited failed reply stays read-only.

Every failed reply reads the same, whatever ended it: a reply cut off by a
shutdown or crash is an ordinary failed reply. `ErrorBlock`'s kind comes from
turn status and the local Retry state only, never from `turn.error` text; the
cause stays in turn metadata for diagnostics.

## Retry, optimistically

`useReplyRetry.ts` mints the new reply's id and, at once, puts a working reply
(`optimisticRetryReply`: pending, empty, `prevTurnId` the failed reply) below
the failed one; the failed reply then reads as history. It then posts `{ id }`
to `POST /api/threads/:threadId/turns/:turnId/retry`. The response's turn
replaces the stand-in by id, and the store's turn (from the live stream or the
snapshot) replaces that.

- **Refused (409 `reply_retry_unavailable`, or `runtime_shutting_down`).**
  Nothing was written. The stand-in goes, the snapshot refreshes, and the
  failed reply carries the generic refused note. The cause never reaches the
  writer; `reportRetryRefused` (`error-telemetry.ts`) logs it for diagnostics.
  Pressing Retry again clears the note.
- **Lost request.** The stand-in stays, failed, and reads "Couldn't start the
  retry. Try again." with its own Retry, which re-sends the same id for the same
  failed reply: a request that did land replays (the server answers 200 with
  the turn it already made). If preparation first creates a compaction, the
  live run records the promised reply id, so the same-id re-send also replays
  while that compaction is running. A failed or stopped compaction in the
  snapshot settles the Retry chain and drops the stand-in. If the server also
  persisted the failed promised successor, that stored turn replaces the
  stand-in by id instead.

Pressing Retry moves focus to the transcript (the button leaves with the error
block) and follows the tail so the new reply is in view. A stand-in has no
action row and reads no lineage; live announcements skip it, so a lost request
is announced once and is not reported as a failed run.

`useRetryStandIns.ts` owns this optimistic half for both this Retry and the
handoff brief's: the stand-in list, placement after the turn it followed
(`placeStandIns` in `retry-stand-ins.ts`), reconciliation by id, the refused
set, and the lost-request re-send. Each caller supplies the POST and the
stand-in's shape.
