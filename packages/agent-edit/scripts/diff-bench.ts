/**
 * Perf of the diff core on a spread-edit manuscript (not a test): `pnpm exec tsx scripts/diff-bench.ts`.
 * Spread: edits in 1 of every 25 paragraphs (a writer's pass or an AI reply across a chapter).
 * Clustered: edits in a contiguous run of paragraphs (typing, or a rewritten scene).
 * Retained: the base array is kept and the draft array is rebuilt from retained nodes, as the editor does.
 * Times are at 1x on this machine; the phone budget (D4) is 6x CPU slowdown.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { cleanupHunks, diffBlocks } from "../src/diff/hunks.js";

const schema = buildDocumentSchema();
const WORDS = Array.from({ length: 4000 }, (_, i) => `w${(i * 7919) % 4000}`);
const WORDS_PER_PARAGRAPH = 80;

function paragraph(words: string[]): PMNode {
  return schema.nodes.paragraph.create(null, schema.text(words.join(" ")));
}

type Shape = "none" | "spread" | "clustered";

function manuscript(totalWords: number, shape: Shape): PMNode[] {
  const count = Math.round(totalWords / WORDS_PER_PARAGRAPH);
  return Array.from({ length: count }, (_, p) => {
    const words = Array.from(
      { length: WORDS_PER_PARAGRAPH },
      (_, w) => WORDS[(p * 31 + w * 13) % WORDS.length] + (w % 17 === 0 ? `_${p}` : ""),
    );
    const edited =
      shape === "spread"
        ? p % 25 === 0
        : shape === "clustered" && p >= count / 2 && p < count / 2 + count / 25;
    if (edited) {
      words[10] = "changed";
      words.splice(40, 3, "a", "new", "clause", "here");
    }
    return paragraph(words);
  });
}

function time(label: string, runs: number, fn: () => unknown) {
  fn(); // warm
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} p50 ${samples[Math.floor(runs / 2)].toFixed(2)} ms  p95 ${samples[Math.floor(runs * 0.95)].toFixed(2)} ms`,
  );
}

for (const words of [10_000, 50_000]) {
  const base = manuscript(words, "none");
  time(`${words} words, identical`, 40, () => diffBlocks(base, [...base]));
  for (const shape of ["spread", "clustered"] as const) {
    const draft = manuscript(words, shape);
    const colds = Array.from({ length: 21 }, () => manuscript(words, shape));
    let next = 0;
    time(`${words} ${shape}, cold nodes`, 20, () => diffBlocks(base, colds[next++]));
    time(`${words} ${shape}, retained nodes`, 40, () => diffBlocks(base, [...draft]));
    const d = diffBlocks(base, draft, { cleanup: false });
    time(`${words} ${shape}, cleanup only`, 40, () =>
      cleanupHunks(d.hunks, d.base.toks, d.draft.toks),
    );
  }
  // One paragraph retyped between recomputes, everything else retained.
  const live = manuscript(words, "spread");
  const mid = Math.floor(live.length / 2) + 1;
  let n = 0;
  time(`${words} one node changed`, 40, () => {
    live[mid] = paragraph([`typed${n++}`, "and", "more", "words", "here"]);
    return diffBlocks(base, [...live]);
  });
}
