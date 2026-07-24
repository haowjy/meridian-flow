# Chat TODO

## Composer-backed ask_user interrupts

`ask_user` interrupts currently render as inline component cards through
`ChoiceBlock`, `TextBlock`, `FormBlock`, and `ComponentResolvedSummary`.

The better direction is to treat an interrupt as a temporary composer mode: the
question and answer controls should sit on or replace the composer surface,
rather than rendering a bulky card in the transcript. Resolved answers should
read as compact conversational receipts.

Track with GitHub issue: #130.

## Composer `@ for reference` rotation hint

When mentions land, restore the legacy compose-placeholder hint: append
", @ for reference" when the writer has not used `@` in seven days. Integrate
it with rotating placeholder selection and the real mention last-use timestamp
rather than carrying a disabled production path. The ported mechanism can be
recovered from the parent of commit `adacbe63`.
