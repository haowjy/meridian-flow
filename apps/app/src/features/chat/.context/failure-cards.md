# Chat failure cards

Every chat failure is a `FailureCard` projected by `chatCards`
(`@meridian/thread-client`). That one projection decides which card exists, its
copy key, its action and its anchor: a turn, a queued command's row, a writer
message, or the composer's card stack. `ChatCards.tsx` draws each card where it
is anchored and decides nothing; `chat-card-copy.ts` words it. No bare
`text-destructive` line reports a chat failure.

## What becomes a card

A temporary problem the writer can act on is a card, never a text line under or
beside a control: a failed Stop, a refused or lost Retry, a failed compaction,
out of usage.

- A failed Stop carries Try again; out of usage carries Add usage. A held row is
  only the queued bubble, and the usage card says why it is held.
- A lost Retry is a card on the failed reply ("Couldn't start the retry." with
  Try again), never an errored stand-in. Refused and lost Retry are detailed in
  [failed-reply-retry.md](failed-reply-retry.md).
- A failed manual compaction's card has Try again, which sends `/compact` again
  with its instructions. An autocompaction's failure stays quiet.
- The queue's cards sit in the composer's card stack
  (`AnchoredCards anchor="composer"`, usage first), because a committed
  hand-back has already removed the queued rows. Try again replays the same
  request; a refused request offers Dismiss only. A queued `/compact` or switch
  whose Stop failed is a card in that control's row ("Couldn't stop the
  compaction.", with Try again in Stop's place).

## Lifetime

A failure shows only while it can be acted on. Once a turn follows a failed
reply, the failure leaves no line, and a failed reply with no content has no
row; `viewTranscript` decides, and a card anchored on the turn keeps its row
drawn (`anchoredTurnIds`). The attempt itself is forgotten server-side
(`turns.forgotten_by_turn_id`): the snapshot keeps the turn stamped
`forgottenBy`, `viewTranscript` hides it, and the `meridian.turns.forgotten`
frame stamps held turns.

## Announcing

One announcer, `useChatCardAnnouncer`, speaks each card key once, and only for a
card the writer watched appear: a card already present when the history settles
is silent. It clears the live region when the card ends. A card never passes
`announce`, and hooks never call `announceError` for a chat failure.

## Feed availability and diagnostics

A terminal socket close or refused subscription supplies an `unavailable`
occurrence through `ThreadSync`, separate from retryable diagnostic errors.
`chatCards` places it above the composer: “Chat updates disconnected”, “Reload
to see the latest replies.”, Reload. Sending remains available. Socket recovery
alone is insufficient: the affected subscription must acknowledge catchup.
The global connection banner only describes transient reconnects.

Command owners emit `failure.recorded` and `failure.ended` at their transitions,
using the same occurrence key as the card. Rendering and announcing do not log.
`FailureLogProvider` keeps a bounded local trace and sends bounded, best-effort
metadata batches to authenticated `/api/diagnostics/failures`. It fences batches
to the account and gives each request a two-second deadline; ingestion failure
stays local and never changes an action's outcome. Missing or foreign targets
lose thread/turn correlation, not the authenticated failure record. Owned
deleted targets retain correlation. No message, prompt, response body or exception text enters that route.
The non-chat `useFailure` hook owns the same lifetime for Work goal editing;
this is not a migration of every error surface.
