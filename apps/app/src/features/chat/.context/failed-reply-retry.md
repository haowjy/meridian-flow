# Failed-reply Retry

A failed reply consumes the messages it answered, and nothing retries it in
the background (boundary-work Amendment A5). So the writer retries it from the
reply itself.

## What the writer sees

| Failed reply | Row |
|---|---|
| Latest turn | Tinted block: "This response failed." with **Retry** beside it |
| Not the latest turn | The quiet line "This response failed.", with no action |
| Its Retry was refused | Adds the muted note "Couldn't retry." while it is the latest turn |
| The provider declined it | "The AI provider turned this request down." with no Retry |

"Latest" is `endsTranscript` in `TurnList`: no visible row follows, and a
divider counts as a row. The client does not gate Retry on the chat being
busy: a failed reply is followed at once by whatever runs next, which takes
its Retry away, and the server refuses a Retry that races a run (409), which
shows the refused note below. A failed first send (`failedSendRetry`) keeps its own "Couldn't
send." Retry, and an inherited failed reply stays read-only.

Every failed reply reads the same, whatever ended it: a reply cut off by a
shutdown or crash is an ordinary failed reply. The one exception is a provider
that declined the request when the gateway judged a resend futile
(`metadata.retryable === false` with `metadata.providerError`,
`isProviderDeclined`): it reads as `provider-declined`, and `AssistantTurn`
omits its Retry. `replyErrorKind` in `AssistantTurn.tsx` picks the kind from
turn status, the local Retry state and that verdict, never from `turn.error`
text; the provider's own message stays in turn metadata for diagnostics.
"Refused" in this component means only the server refusing a Retry.

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
  Pressing Retry again clears the note, and so does any row landing below the
  failed reply: like Retry, the note belongs to the current reply only.
- **Lost request.** The stand-in stays, failed, and reads "Couldn't start the
  retry. Try again." with its own Retry, which re-sends the same id for the same
  failed reply: once the server has stored a reply under that id, the re-send
  replays (200 with that turn), including a reply that follows the compaction
  its Retry started. While the chat is still busy (for example that compaction
  is running and the reply is not stored yet) the re-send is refused like any
  other and the stand-in goes. The refused note shows only while the failed
  reply is the latest turn, so here the running divider below it carries the
  state. The lost request did land, so the run goes on, and its reply still
  lands under the id the writer minted, from the snapshot. A failed or stopped
  compaction in the snapshot settles the Retry chain and drops the stand-in.

Pressing Retry moves focus to the transcript (the button leaves with the error
block) and follows the tail so the new reply is in view. A stand-in has no
action row and reads no lineage; live announcements skip it, so a lost request
is announced once and is not reported as a failed run.

`useRetryStandIns.ts` owns this optimistic half for both this Retry and the
handoff brief's: the stand-in list, placement after the turn it followed
(`placeStandIns` in `retry-stand-ins.ts`), reconciliation by id, the refused
set, and the lost-request re-send. Each caller supplies the POST and the
stand-in's shape.
