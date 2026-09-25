# Chat TODO

## Optimistic interaction contract

- **CHAT-004: Prove interrupt-response settlement at runtime, or scope it explicitly.** Local settlement is implemented and keyed by `(threadId, turnId, interruptId)`: pending/ambiguous/`failed`, socket-generation close, snapshot reconciliation, newest-pending error correlation, and one in-flight response per tuple. Still missing: a browser probe for disconnect-before-ack, Retry, double-submit, and pending-survives-remount (SPEC Phase 6 / A3); contract tests do not substitute. The settlement is memory-only across reload; the server journal owns the outcome.

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

## Composer `@ for reference` rotation hint

When mentions land, append ", @ for reference" to the rotating composer
placeholder when the writer has not used `@` in seven days. Drive it from the
real mention last-use timestamp rather than a disabled placeholder path.

## Unbounded project chat list ([#593](https://github.com/haowjy/meridian-flow/issues/593))

Every project load downloads every thread unpaged (`useProjectThreads` →
`GET /api/projects/:id/threads`). The switcher lists and searches it, and
title, Agent, and Work lookups read it by id. Chats grow without bound, so move
the switcher onto the paged, server-searched chat feed the index uses
(virtualized), point per-chat lookups at the thread snapshot or cached feed
rows, and delete the whole-project list. Consumers are listed in the issue.

## Favorite state applied three times ([#597](https://github.com/haowjy/meridian-flow/issues/597))

A chat's Favorite reaches the screen three ways: projected onto each fetched
feed page, rewritten into cached pages by `syncChatFeeds` after every command
step, and read again per row by `useProjectChatUserState`. The cached copy exists
only for the Favorites filter. Keep feed caches as server truth, hold Favorite
records in one per-project map, and apply it at read time for rows and filter
alike.
