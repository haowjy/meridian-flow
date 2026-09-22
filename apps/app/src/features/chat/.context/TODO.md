# Chat TODO

## Optimistic interaction contract

- **CHAT-001: Give every displayed send a durable account-scoped witness.** Existing-thread sends are memory-only and new-thread first sends use same-tab `sessionStorage`; reload or tab close can lose a row whose server outcome is still ambiguous. Persist the intent before dispatch, retain `submissionId`, replay or look it up idempotently, and fence it by account.
- **CHAT-002: Persist thread rename or stop announcing success.** `useRenameThread.ts` patches caches and announces completion without a server command, so reload restores the old title. Add a set-semantics title endpoint with P1 rejection handling, or remove the misleading committed-state treatment.
- **CHAT-003: Align send classification while preserving each destination's recovery UI.** Mark optimistic user turns as pending until acknowledgement and attach definitive failure to the turn instead of only restoring the composer. Existing-thread ambiguity keeps Composer Check submission status / Start over; first-send ambiguity keeps Retry on the destination turn. Both must retain the row and must not present an unknown outcome as rejection.
- **CHAT-004: Show interrupt-response settlement.** Keep agent resolution server-confirmed, but give the interrupt card an explicit pending state and a visible retryable failure when the fire-and-forget transport does not settle.

## `ls` chevron decision still parses eagerly

`listingOrNothing` normalizes listing rows at render time to decide the
chevron, unlike `search` (whose affordance is a cheap check on the validated
contract with normalization inside the expand thunk). Bounded cost (cap 8, no
totals scan), but it is the same closed-rows-do-no-work contract. Fixing it
needs the same boundary-validation treatment the search payload got, so the
cheap check and the parser cannot disagree. See
`activity-row-anatomy.md` for the two ways to keep chevron and parser
agreeing.

## Composer-backed ask_user interrupts

`ask_user` interrupts currently render as inline component cards through
`ChoiceBlock`, `TextBlock`, `FormBlock`, and `ComponentResolvedSummary`.

The better direction is to treat an interrupt as a temporary composer mode: the
question and answer controls should sit on or replace the composer surface,
rather than rendering a bulky card in the transcript. Resolved answers should
read as compact conversational receipts.

Track with GitHub issue: #130.

## `continue` tool rows are not hidden

`tool-view-visibility.ts` hides the protocol rows for `ask_user`, `spawn`, and
`return_result`, but not `continue`. A model `continue` persists the same
`helper-result` card as `spawn`, so the writer sees an extra humanized
"continue" activity row in the Thinking fold beside the card. Add `continue` to
the hidden set so a continue reads like a spawn (`tool-view-visibility.ts`, with
the same parity in `partition-turn.ts` and `tool-renderers.tsx`).

## Composer `@ for reference` rotation hint

When mentions land, append ", @ for reference" to the rotating composer
placeholder when the writer has not used `@` in seven days. Drive it from the
real mention last-use timestamp rather than a disabled placeholder path.
