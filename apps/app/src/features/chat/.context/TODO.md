# Chat TODO

## Composer-backed ask_user interrupts

`ask_user` interrupts currently render as inline component cards through
`ChoiceBlock`, `TextBlock`, `FormBlock`, and `ComponentResolvedSummary`.

The better direction is to treat an interrupt as a temporary composer mode: the
question and answer controls should sit on or replace the composer surface,
rather than rendering a bulky card in the transcript. Resolved answers should
read as compact conversational receipts.

Track with GitHub issue: #130.

## Composer `@ for reference` placeholder hint (gated off)

`placeholders.ts` ports the legacy conditional hint — append ", @ for
reference" to the compose placeholder when the writer hasn't used `@` in
7 days — but keeps it disabled because v3 has no @ mentions yet. When
mentions land: enable in `getComposePlaceholder` / `useComposerPlaceholder`
and pass the real last-use timestamp (see the TODO comment there).
