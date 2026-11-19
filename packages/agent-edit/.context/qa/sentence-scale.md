# Sentence-scale differential for `stands` and membership

`sentence-scale.probe.ts` runs `content-merge/stands.ts` over generated drafts: three or four
paragraphs of two to four sentences with punctuation and quotes. Each row is one AI edit of one to
three parts (reword, rewrite or delete a sentence, insert one, rewrite or add a paragraph), then one
to four later edits by the writer, a later reply or Live (split, join, move, reword), carried in by
the pull's own merge, then (60% of rows) an Apply of one change. The oracle is the same row without the
AI edit. It needs no database or browser and is not part of `pnpm check`. Run it when
`content-merge/stands.ts`, the merge's rules, or `diff/review.ts`'s cut change.

```bash
cd packages/agent-edit
pnpm exec vitest run --config .context/qa/sentence-scale.vitest.config.ts
ROWS=12000 SEED=100000 OUT=/tmp/ss pnpm exec vitest run --config .context/qa/sentence-scale.vitest.config.ts -t differential
```

It fails when:

- a pending change the edit caused (one the oracle lacks) is named by no change of the edit
  (membership misses);
- the windowed membership names a pending change the whole-document membership does not;
- a change that stands is in no pending change, or an Apply of one change leaves a still-proposed
  change outside Changes;
- an Undo glues or cuts a word, a change still stands after its Undo, or a second press would
  change the text.

The windowed read may name fewer than the whole-document one: the whole-document diff re-aligns
the tail of the document when a change is forced out and names a group there that neither the
oracle nor the window counts (printed as `whole-document read names a group more`).

The second test, `bench`, rebuilds a 4,700 and a 19,000-word draft with 40 AI edits and times the
card's read (state and membership of every change) cold, after a write elsewhere and after a write
inside one change, with fresh nodes each time.

`Pins implementation decisions`: the removal rule for membership with its word fallback for changes
the merge cannot pair, the round-trip rule for `stands`, the window of one block either side.
