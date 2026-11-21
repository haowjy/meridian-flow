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
slot, and the `FUZZ_SEED=<seed> FUZZ_EDITS=<n>` that replays the run up to that edit. Below it,
vitest diffs the full paint's sorted decorations (expected) against the incremental ones
(received), so a decoration painted twice fails too. A replay picks the same edits and the same
focus, but `rewrite` makes fresh change ids, so match a replayed failure by edit number and
position, not by the focused id.

The seed goes through mulberry32, as in the other probes. A plain multiply-and-mask generator
loses its low bits past 2^53 in JavaScript, and every seed falls into one short cycle.

## Last run: 2026-11-20, on `feat/suggestions` 6379239292

- Seeds 1 to 4, 20,000 edits each, about 58,500 repaints compared per seed: 0 mismatches, about
  9 s a seed. The default 2,000 edits take about 1 s.
- Bugs put back by hand fail fast. On seed 1: the slot left where it was after an edit (the bug
  review found in PR #1797) at edit 17, and every repainted decoration painted twice at edit 1.
  Dropping the overlap adjustment in `repaintEdit` (an edit that repeats the text beside it)
  fails on each of seeds 4 and 8 to 12, at edits 288 to 3,968.
