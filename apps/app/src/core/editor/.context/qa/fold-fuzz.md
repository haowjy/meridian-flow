# Fold fuzz: random concurrent editing through the binding

`fold-fuzz.probe.ts` checks the patched `@tiptap/y-tiptap` binding
(`patches/@tiptap__y-tiptap@3.3.0.patch`) and agent-edit's writer against each other under
random concurrent edits. Two or three real TipTap editors, each on its own `Y.Doc`, type,
delete, insert empty paragraphs, bold and align, and the first editor moves runs of one to three
blocks the way a drag does. A server peer writes into the same paragraphs
through `writeBlocks` and `applyOps`. Updates travel as they do in the app: an editor talks only
to the server, the server relays to the others, and each link delivers in order at random times.
After a full sync, a run fails when:

- a typed character its typist didn't delete is missing, or appears twice;
  characters typed into a block someone moved are not counted, because Yjs has no move and a
  dragged block is re-created;
- a character's Yjs item no longer belongs to the client that typed it (its byline moved);
- a character sits in a block other than the one it was typed into, by block `id`;
- two blocks share an `id`;
- a server `writeBlocks` call inserted or deleted a block instead of editing it in place;
- the Yjs docs, or the editors' ProseMirror docs, disagree.

It needs no database, dev stack or browser, and it is not part of `pnpm check` or CI. Run it
when the y-tiptap patch, the editor's Yjs binding or agent-edit's writer changes; for those
changes, run 600 seeds.

```bash
cd apps/app
pnpm exec vitest run --config src/core/editor/.context/qa/fold-fuzz.vitest.config.ts
FUZZ_SEEDS=600 pnpm exec vitest run --config src/core/editor/.context/qa/fold-fuzz.vitest.config.ts
```

`FUZZ_SEEDS` (default 100) sets the number of runs and `FUZZ_STEPS` (default 120) the edits
per run. It prints one JSON line of totals with the first 20 failing seeds. The seed also sets
the Yjs client ids and the block ids, so a seed replays the same run: `FUZZ_SEEDS=<n>` plus a
log line in `run()` gives a failing case to trace.

The probe's own mistakes look like binding bugs, so check these first:

- Each editor builds its own schema. A mark made from another editor's schema is a different
  `MarkType`, and ProseMirror keeps it beside its own (`strong` twice on one text).
- Two editors moving one block at once each re-create it, so the document ends with two copies
  under one `id`, and `writeBlocks` then rebuilds blocks. That is a known limit of moves, so only
  one editor moves.
- Peers connected to each other directly, instead of through the server, can apply an update
  before the one it builds on. Yjs then shows a deletion and holds back the item that replaces
  it, so a paragraph briefly loses its `id` and `writeBlocks` throws.

## Last run: 2026-11-14, on `origin/main` 881f5d7fc2 and this branch

- This branch, 600 seeds × 120 steps, 36,024 typed characters: 0 lost, 0 duplicated, 0 moved
  bylines, 0 in the wrong block, 0 shared ids, 0 rebuilt blocks, 0 diverged runs. About 50 s.
- `main`, same probe: 30 lost characters, 1,263 moved bylines, 2,290 in the wrong block, 15
  shared ids and 122 rebuilt blocks. `main`'s binding pairs elements by position, so a paragraph
  inserted or moved beside another takes over that block's element.
