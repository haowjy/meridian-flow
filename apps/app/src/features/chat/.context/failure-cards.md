# Chat failure cards

`chatCards` (`@meridian/thread-client`) decides which card exists, its copy key, its
action and its anchor. `ChatCards.tsx` draws each card and decides nothing;
`chat-card-copy.ts` words it. Who sees a failure and for how long is in
[Failures](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/failures.md).

A running subagent's failed Stop is the exception: the strip draws `handBackCards`
on that child's row, because the failure is the child's, not this chat's.

## Announcing

`useChatCardAnnouncer` speaks each card key once, and only for a card the writer
watched appear: a card already present when the history settles is silent. It clears
the live region when the card ends. A card doesn't pass `announce`, and hooks don't
call `announceError` for a chat failure.

## Feed availability

A terminal socket close or refused subscription supplies an `unavailable` occurrence
through `ThreadSync`, separate from retryable diagnostic errors. Socket recovery
alone isn't enough: the affected subscription has to acknowledge catchup. The global
connection pill (`ConnectionBanner`) only describes transient reconnects.

## Failure logging

Command owners emit `failure.recorded` and `failure.ended` at their transitions,
under the card's occurrence key; rendering and announcing don't log.
`FailureLogProvider` keeps a bounded local trace and sends bounded, best-effort
metadata batches to authenticated `/api/diagnostics/failures`. It fences batches to
the account and gives each request a two-second deadline; ingestion failure stays
local and never changes an action's outcome. Missing or foreign targets lose
thread/turn correlation, not the authenticated failure record; owned deleted targets
keep it. No message, prompt, response body or exception text enters that route. The
non-chat `useFailure` hook owns the same lifetime for Work goal editing.

## Queued compactions

One owner entry holds admission evidence, enqueue and withdrawal attempts, and
snapshot removal proof, and reconciles raw server items and transcript answers before
projecting rows. Optimistic hiding doesn't delete pending-attempt evidence, and a
snapshot older than admission can't retire an unadmitted enqueue. Write-mode switches
keep their submission-journal owner.
