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
| The provider declined it | "The AI provider turned this request down." with **Retry** when latest and a retry handler is present |

"Latest" is `endsTranscript` in `TurnList`: no visible row follows, and a
divider counts as a row. The client does not gate Retry on the chat being
busy: a failed reply is followed at once by whatever runs next, which takes
its Retry away, and the server refuses a Retry that races a run (409), which
shows the refused note below. An unadmitted message keeps its "Couldn't send."
Retry on the writer row, not here, drawn in the same `ErrorCard` shell as an
inline, one-line card that is not itself an alert (the chat announces it once
through its own region). An inherited failed reply stays read-only.

Every failed reply reads the same, whatever ended it: a reply cut off by a
shutdown or crash is an ordinary failed reply. The one exception is a provider
that declined the request when the gateway ruled out an automatic retry
(`metadata.retryable === false` with `metadata.providerError`,
`isProviderDeclined`): it reads as `provider-declined`, with Retry under
the same conditions as other failed replies. A writer's explicit Retry is not
blocked by that verdict: it may succeed once the cause is fixed.
`replyErrorKind` in `AssistantTurn.tsx` picks the kind from turn status, the local Retry state and that verdict, never from `turn.error`
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
  failed reply. If the lost request landed, the server answers the replay with
  the execution it started (`{ executionId, turn }`, `turn` null until the reply
  is reserved), or `retry_pending` (503) while it can't tell yet. Pending
  answers repeat the same id after the response's `Retry-After`, up to
  `RETRY_PENDING_ATTEMPTS` automatic sends; past that the stand-in is lost again,
  unresolved and retryable, never refused.
- **Its run ends without the reply.** The stand-in keeps the execution its
  Retry answered. When the response was lost it reads that execution off the
  turn whose `metadata.retryReplyId` is the stand-in's id (the request's first
  reserved turn, often a compaction). Once the controller's run facts
  (`useRunFacts`, which renders whenever the controller's facts change) show
  that execution ended and none of its turns is the requested reply (a stopped
  compaction), nothing will create it and the stand-in goes. An end on the
  stream is enough; it does not wait for a snapshot refresh. Placement next to a compaction is never evidence: a
  mode switch can sit between the failed reply and its compaction.

Pressing Retry moves focus to the transcript (the button leaves with the error
block) and follows the tail so the new reply is in view. A stand-in has no
action row and reads no lineage; live announcements skip it, so a lost request
is announced once and is not reported as a failed run.

`useRetryStandIns.ts` owns this optimistic half for both this Retry and the
handoff brief's: the stand-in list, placement after the turn it followed
(`placeStandIns` in `retry-stand-ins.ts`; it goes after the `write_mode_switch` turns that directly
follow the failed reply, so failed reply, switch, Retry, while a newer writer message still comes
after it), reconciliation by id, the refused
set, and the lost-request re-send. Each caller supplies the POST, the
stand-in's shape and, for a reply, when its reservation ended (`retired`). A
handoff brief holds no execution; its seed's id is its only identity.
