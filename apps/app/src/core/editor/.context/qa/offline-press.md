# Offline typing against a press

`offline-press.probe.ts` builds a two-paragraph chapter, has the AI rewrite it in up to three
drafts (agent-edit's drafted write), and mounts two real TipTap editors on their own `Y.Doc`s: a
desk tab in a random view (Live or a draft) and a phone tab. The desk types and deletes at random
offline. Meanwhile one draft is applied or discarded, by the server's press or by the phone's
inline Apply/Reject. Then the desk reconnects and moves its caret (the binding writes on every view
update). Per character, each mark must end as one side left it: a side that changed the mark
wins, two that changed it may either win, and with neither it is as before. No live mark may
belong to a change some resolve decided.

It guards how Yjs keeps a mark: an item that opens it and one that closes it. Three things broke
that under concurrency and hid words from Live (the final prober's p18878 run, `Live` cut to
"Lin Feng rose"):

- The binding re-formatted every run of a paragraph on each edit, moving the opening of a span
  with no text left in it. The y-tiptap patch formats only runs whose marks differ.
- A delete cleaned up the format items it left redundant, and each peer cleaned up formatting
  after a remote change; a peer's concurrent insert between those items needed them. The yjs
  patch turns both cleanups off.
- Typing inside a change's text re-opens its mark after the typing; a concurrent resolve of that
  change deletes the closing item. `dropResolvedMarks` (agent-edit), run by each tab on what it
  receives, deletes every mark item of a decided change.

On the commit before the fix, about 10% of runs fail. No database, dev stack or browser. Run it
when the y-tiptap or yjs patch, `rewrite`, the resolve or `dropResolvedMarks` changes:

```bash
cd apps/app
FUZZ_RUNS=1000 pnpm exec vitest run --config src/core/editor/.context/qa/offline-press.vitest.config.ts
```

`FUZZ_SEED=<n> FUZZ_RUNS=1 FUZZ_DEBUG=1` replays one seed and prints each text's Yjs items at the
four steps (`~` marks a deleted item; `{key=draft}` a format item, `-` a closing one).
