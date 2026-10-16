# Failed-reply Retry

A failed reply consumes the messages it answered, and nothing retries it in
the background (boundary-work Amendment A5). So the writer retries it from the
reply itself.

## What the writer sees

| Failed reply | Row |
|---|---|
| Latest turn | A projected `FailureCard` anchored on the reply: "This response failed." with **Retry** |
| Not the latest turn, never retried | No failure line. With no text or items it has no row at all (no grey line, no empty icons row); with partial text it keeps the text and items |
| Retried (accepted or pending) | Not drawn: the Retry's row takes its place |
| A retry that failed too | One failure, the newest, in that same place |
| Its Retry was refused | Only a red error card "Couldn't retry." on that reply ("Couldn't retry. Another reply started first." for a 409), with no "This response failed." above it once the chat moved past it (a failure still latest keeps its own card, and the refusal is a second card under it). The reply's row stays showing just the card, with no action icons if it has no content. Temporary: it clears when the next reply completes, or at the writer's next Retry or send; a reply that fails or is cancelled leaves it |
| The provider declined it | "The AI provider turned this request down." with **Retry** when latest |

A failure shows only while the writer can act on it. Whether a failed reply that is
not the latest has a row is decided in `viewTranscript` (no row without items or
deliveries, unless a card is anchored on it, `anchoredTurnIds`). `chatCards` decides every card
(a `FailureCard` per anchor). "Latest" is `latestRow` over the normalized turns:
no closing turn (`isClosingRow`, drawn or not) follows it, so a divider counts and an agent's message, which draws no
row, does too. `chatMovedPast` in `@meridian/thread-client/view` is the one reader; handoff seeds use it as well. The client does not gate Retry on the chat being
busy: a failed reply is followed at once by whatever runs next, which takes
its Retry away, and the server refuses a Retry that races a run (409), which
shows the refused card below. An unadmitted message keeps its "Couldn't send."
Retry on the writer row, not here, drawn as a `FailureCard`, an
inline, one-line card that is not itself an alert (the chat announces it once
through its own region). An inherited failed reply stays read-only.

Every failed reply reads the same, whatever ended it: a reply cut off by a
shutdown or crash is an ordinary failed reply. The one exception is a provider
that declined the request when the gateway ruled out an automatic retry
(`metadata.retryable === false` with `metadata.providerError`,
`isProviderDeclined`): it reads as `provider-declined`, with Retry under
the same conditions as other failed replies. A writer's explicit Retry is not
blocked by that verdict: it may succeed once the cause is fixed.
`chatCards` picks the failure and recovery from turn facts and Retry outcomes;
`chat-card-copy.ts` words its copy key. Provider classification never depends on
`turn.error` text; the provider's own message stays in metadata for diagnostics.
"Refused" in this component means only the server refusing a Retry.

## Retry, optimistically

`useReplyRetry.ts` mints the new reply's id and, at once, puts a working reply
(`optimisticRetryReply`: pending, empty, `prevTurnId` the failed reply) below
the failed one, and the failed reply is no longer drawn: the transcript is not a log, so
the Retry's row is in its place (`viewTranscript` drops a turn that a stand-in or stored
turn names with `metadata.retryOf`, and one in the explicit `retried` set, after placing
stand-ins; a chain of failed retries draws only the newest). Suppression is drawing only: the
failed reply stays in the store. It then posts `{ id }`
to `POST /api/threads/:threadId/turns/:turnId/retry`. The response's turn
replaces the stand-in by id, and the store's turn (from the live stream or the
snapshot) replaces that.

- **Refused (409 `reply_retry_unavailable`, or `runtime_shutting_down`).**
  Nothing was written. The stand-in goes, the snapshot refreshes, and the
  failed reply carries the generic refused error card. The cause never reaches the
  writer; `reportRetryRefused` (`error-telemetry.ts`) logs it for diagnostics.
  Any Retry or send clears every card (`clearRefused`). A reply that completes
  after the refusal clears it too: `useRetryStandIns` records, per refusal, the
  replies already complete, and the card ends when a stored reply completes that
  wasn't among them (durable turn status, no timers). A row landing below the
  failed reply, or a reply that fails or is cancelled, does not clear it.
- **Lost request.** The entry stays held, failed, but is no stand-in: the failed reply
  shows again with a card, "Couldn't start the retry." with Try again (`chatCards`'
  `retry-lost`), and no error row. Try again re-sends the same id for the same
  failed reply (`attempt` counts the presses). If the lost request landed, the
  server answers the replay with
  the execution it started (`{ executionId, turn }`, `turn` null until the reply
  is reserved), or `retry_pending` (503) while it can't tell yet. Pending
  answers repeat the same id after the response's `Retry-After`, up to
  `RETRY_PENDING_ATTEMPTS` automatic sends; past that the request is lost again,
  unresolved and retryable, never refused. The card goes once the chat moves past the
  reply, or the store has the request's reply by id.
- **Its run ends without the reply.** The stand-in keeps the execution its
  Retry answered and the version of the run-state record that answer carried.
  Once the held record, at or past that version, shows no execution or another
  one, nothing will create the reply (a stopped compaction) and the stand-in
  goes. A lost response has no version, so its failed stand-in waits for the
  writer's Retry, which replays the request. Placement next to a compaction is
  never evidence: a mode switch can sit between the failed reply and its
  compaction.

Pressing Retry moves focus to the transcript (the button leaves with the error
block) and follows the tail so the new reply is in view. A stand-in has no
action row and reads no lineage; live announcements skip it, so a lost request
is announced once and is not reported as a failed run.

One rule decides retirement: `reconcileRetries` in `@meridian/thread-client`
(`src/run-state/retry.ts`) takes the entries, the stored turns and the
run-state view, and returns the entries that remain, those drawn as stand-ins,
and the failed replies hidden for them. `useRetryStandIns.ts` keeps transport
and storage for both this Retry and the handoff brief's: the stand-in list,
placement after the turn it followed (`placeStandIns`, run by `viewTranscript`; it goes after the
`write_mode_switch` turns that directly follow the failed reply, so failed reply, switch, Retry, while a
newer writer message still comes after it),
the refused set and the lost-request re-send. Each caller supplies the POST and
the stand-in's shape. A
handoff brief holds no execution; its seed's id is its only identity.

A failed reply that a Retry or a later message follows is **forgotten**, one stored
fact (`turns.forgotten_by_turn_id`) the server writes in the transaction that appends
the following turn. Retry forgets the failure and keeps the writer's message; moving
on from a failure that drew nothing forgets the attempt and its messages too. The
snapshot keeps forgotten turns, stamped `forgottenBy`; `viewTranscript` hides them
(a reply a card is anchored on stays), and `markForgotten` stamps held turns from the
`meridian.turns.forgotten` frame. Reconcile and snapshots never clear a stamp. A
failure with a tool call, or one carried into a continuation, stays.
