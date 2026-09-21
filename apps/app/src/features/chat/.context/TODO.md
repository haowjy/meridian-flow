# Chat TODO

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
