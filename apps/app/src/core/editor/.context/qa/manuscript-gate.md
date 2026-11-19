# Manuscript gate: content Undo against the Yjs kernel, through the real write paths

`manuscript-gate.probe.ts` decides whether an AI edit in the manuscript can be undone by reading
its recorded content instead of following Yjs item ids (stage 3 of the single-truth design deletes
the inverse kernel only if it can). Both Undos run on the same writes:

- **The AI** writes through the model's tools (`core.write` with `replace` and `insert`, which lower
  a find and a replacement into Yjs operations), in the agent-edit harness's in-memory room.
- **The writer** types in a real TipTap editor on its own `Y.Doc`, bound by `@tiptap/y-tiptap` and
  relayed to the room as the app relays it (the editor talks to the room only).
- **The kernel's Undo** is `computeInverse` over the receipt parts captured around each AI write.
- **The content Undo** is the design's read: a change stands when its inverse merges without a
  conflict and putting it back gives the text again; the result is written with `writeBlocks`.
  The probe carries its own copy of that read (the prototype's), because stage 1 has not put
  `stands` into `content-merge/` yet; when it does, point the probe at it.

Each row is played in three fresh worlds from one script: the kernel Undo, the content Undo, and
the oracle (the same later typing and later AI edits without the AI edit being undone). A row is
independent when the oracle's script still applies; only independent rows are judged against it.
Row kinds: four documents (`plain`; `marks`, bold words in a sentence; `table`, cell text; `image`,
an inline image between sentences) times two timings (`synced`: the writer's typing reaches the
room before the Undo; `unsent`: the writer's last typing, aimed at the sentences the AI wrote,
is held in the browser until after the Undo).

Counted per kernel and per content: rows matching the oracle, glued words (a word between spaces
that is neither vocabulary nor something the writer typed, so `garden.zq1` and `zq1The` both count),
lost words (a typed word whose letters are gone), and rows where the Undo changes the text
(kernel) or any change stands (content). The probe's rule line is the design's: no word lost by
content that the kernel keeps, no glued word the kernel does not have, and content matching the
oracle in no fewer rows.

It needs no database, stack or browser and is not part of `pnpm check` or CI. Run it when the
inverse kernel, `content-merge`, the writer or the editor binding changes, or stage 3 is reconsidered:

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

## Last run: 2026-11-18, on `origin/main` 87b3ec585d

400 rows per kind, 3,200 rows, 505 independent:

| | Kernel | Content |
|---|---:|---:|
| Independent rows matching the oracle | 505 | 496 (the other 9 left one change of several in) |
| Rows with a glued word / glued words | 1,039 / 1,103 | 273 / 273 |
| Rows with a lost word | 164 | 163 |
| Rows where content lost a word the kernel kept | | 0 |
| Rows where content glued and the kernel did not | | 2 |
| Rows where Undo is offered | 3,120 | 2,727 (2,277 for every change) |

The two rows of new glue are unsent typing that replaced a word inside a sentence the Undo
restored. Full table by kind and the reading: the gate's results page in the design's work
directory (`never-refuse/findings/single-truth/stage0-gate.md`).
