# Fold fuzz: random concurrent editing through the binding

`fold-fuzz.probe.ts` checks the patched `@tiptap/y-tiptap` binding
(`patches/@tiptap__y-tiptap@3.0.5.patch`) and agent-edit's writer against each other under
random concurrent edits. Two or three real TipTap editors, each on its own `Y.Doc`, type,
delete, insert empty paragraphs, bold and align. A server peer writes into the same paragraphs
through `writeBlocks` and `applyOps`. Updates travel as they do in the app: an editor talks only
to the server, the server relays to the others, and each link delivers in order at random times.
After a full sync, a run fails when:

- a typed character its typist didn't delete is missing, or appears twice;
- a character's Yjs item no longer belongs to the client that typed it (its byline moved);
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
per run. It prints one JSON line of totals with the first 20 failing seeds. A seed replays the
same run, so `FUZZ_SEEDS=<n>` plus a log line in `run()` gives a failing case to trace.

The probe's own mistakes look like binding bugs, so check these first:

- Each editor builds its own schema. A mark made from another editor's schema is a different
  `MarkType`, and ProseMirror keeps it beside its own (`strong` twice on one text).
- Peers connected to each other directly, instead of through the server, can apply an update
  before the one it builds on. Yjs then shows a deletion and holds back the item that replaces
  it, so a paragraph briefly loses its `id` and `writeBlocks` throws.

## Last run: 2026-11-14, on `origin/main` 24c79441fa plus this branch

- 600 seeds × 120 steps, 35,940 typed characters: 0 lost, 0 duplicated, 0 moved bylines,
  0 rebuilt blocks, 0 diverged runs. About 45 s.
- Control, without the `sameBlock` check in `updateYFragment`: 13 of 600 runs failed, with 33
  lost characters, 15 moved bylines and 82 rebuilt blocks. Inserting an empty paragraph before
  another empty paragraph wrote the new paragraph into the old element, so two elements carried
  one `id` and the merge paired the wrong blocks.
