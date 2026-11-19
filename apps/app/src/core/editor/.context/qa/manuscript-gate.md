# Manuscript gate: the content Undo through the real write paths

`manuscript-gate.probe.ts` checks how an Undo of an AI edit in the manuscript, read from its
recorded content, comes out when the writes go through the real paths. It was the gate for deleting
the Yjs inverse kernel (stage 3 of the single-truth design, now done); it stays as the check on
`content-merge`, the writer and the editor binding. Both worlds run the same writes:

- **The AI** writes through the model's tools (`core.write` with `replace` and `insert`, which lower
  a find and a replacement into Yjs operations), in the agent-edit harness's in-memory room.
- **The writer** types in a real TipTap editor on its own `Y.Doc`, bound by `@tiptap/y-tiptap` and
  relayed to the room as the app relays it (the editor talks to the room only).
- **The content Undo** is the design's read: a change stands when its inverse merges without a
  conflict and putting it back gives the text again; the result is written with `writeBlocks`.
  It is the server's own read (`changeStateIn` and `takeOut` in `content-merge/stands.ts`).

Each row is played in two fresh worlds from one script: the content Undo, and the oracle (the same
later typing and later AI edits without the AI edit being undone). A row is independent when the
oracle's script still applies; only independent rows are judged against it.
Row kinds: four documents (`plain`; `marks`, bold words in a sentence; `table`, cell text; `image`,
an inline image between sentences) times two timings (`synced`: the writer's typing reaches the
room before the Undo; `unsent`: the writer's last typing, aimed at the sentences the AI wrote,
is held in the browser until after the Undo).

Counted: independent rows whose text matches the oracle, glued words (a word between spaces that is
neither vocabulary nor something the writer typed, so `garden.zq1` and `zq1The` both count), lost
words (a typed word whose letters are gone), and rows where any change stands (Undo is offered).

It needs no database, stack or browser and is not part of `pnpm check` or CI. Run it when the
`content-merge`, the writer or the editor binding changes:

```bash
cd apps/app
NODE_OPTIONS=--max-old-space-size=12000 GATE_ROWS=400 \
  pnpm exec vitest run --config src/core/editor/.context/qa/manuscript-gate.vitest.config.ts
```

`GATE_ROWS` (default 60) is the rows per kind; 400 takes about 2.5 minutes and needs the larger
heap (jsdom documents pile up across 9,600 worlds). A row replays from its seed, and the
output ends with up to three scripts and texts for each kind of surprise. Rows the probe could not
play (a find that occurs twice, an AI write that changed nothing) are listed and not counted.

What it does not cover: the AI's `overwrite`, `move` and `remove`; two writers at once; typing key
by key (a word is one transaction); an image or table made by the AI; a document the Undo
leaves with no block left of the AI's.

## Last run: 2026-11-19, on the stage 3 branch

400 rows per kind, 3,200 rows, 505 independent. These are the numbers the stage 0 gate recorded for
content (2026-11-18, `origin/main` `87b3ec585d`), unchanged:

| | Content |
|---|---:|
| Independent rows matching the oracle | 496 (the other 9 left one change of several in) |
| Rows with a glued word | 273 |
| Rows with a lost word | 163 |
| Rows where Undo is offered | 2,727 (2,277 for every change) |

Stage 0 ran the Yjs kernel beside it: 505 matches, 1,039 rows with a glued word, 164 with a lost
word. That comparison is why the kernel was deleted; the gate's results page in the design's work
directory (`never-refuse/findings/single-truth/stage0-gate.md`) has it by kind.
