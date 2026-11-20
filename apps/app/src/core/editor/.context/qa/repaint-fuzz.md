# Repaint fuzz: incremental suggestion paint against a full paint

`repaint-fuzz.probe.ts` checks the suggestion editor's paint
(`extensions/suggestion-mode/suggestion-paint.ts`). After an edit or a focus move, `repaint`
paints again only the top-level blocks the edit reached and those holding the old and new
focused change, then places the bar's slot. The probe checks that the result is always the
decoration set `paintAll` would draw for the whole document.

Each run starts documents with a heading, paragraphs, a horizontal rule, a table with a
two-paragraph cell and nested `jsx_container`s, and replaces the document every 40 edits. Each
edit comes from Work `w1`, Work `w2` or Live and goes through `rewrite`, so it leaves real
suggestion marks and block attributes: inserts, deletes, replaces, splits, joins, block inserts
and deletes, heading level changes, and bold added or removed. One edit in five is followed by
a whole-document replace with rebuilt nodes, as y-tiptap redraws after Undo, a peer's edit or
the tab's Apply. After every edit the probe repaints in all three views (`w1`, `w2`, Live),
moves focus to a random change and opens or closes the slot at random, then compares the
decorations by position, kind, attributes, change id and key (the slot is one keyed widget).

It needs no database, dev stack or browser, and it is not part of `pnpm check` or CI. Run it
when `suggestion-paint.ts`, the suggestion marks or `rewrite` change:

```bash
cd apps/app
pnpm exec vitest run --config src/core/editor/.context/qa/repaint-fuzz.vitest.config.ts
FUZZ_EDITS=20000 pnpm exec vitest run --config src/core/editor/.context/qa/repaint-fuzz.vitest.config.ts
```

`FUZZ_EDITS` (default 2000) sets the edits per run; each edit is checked in three views. Each
run picks a new random seed and prints it in one JSON line of totals. A run stops at the first
mismatch, and its message names the seed, the edit, who made it, the view, the focus and the
slot, and the `FUZZ_SEED=<seed> FUZZ_EDITS=<n>` that replays the run up to that edit. The
decorations the full paint has and the incremental one lacks are under `missing`, the reverse
under `extra`.

## Last run: 2026-11-20, on `feat/suggestions` 6379239292

- 2,000 edits, 5,892 repaints compared: 0 mismatches, about 1 s.
- With either of two bugs put back by hand it fails within 600 edits on seed 1: the slot left
  where it was after an edit (the bug review found in PR #1797), and `repaintRange` not reaching
  one position past the edit, which misses a horizontal rule's focus.
