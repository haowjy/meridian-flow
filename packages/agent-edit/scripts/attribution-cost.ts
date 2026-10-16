/**
 * Cost probe for the attribution classifier (docs/qa/README.md). Not a unit test: it prints the median
 * time of `classifyChanges` for chapters of 100-word paragraphs where an AI part replaced one word in
 * some of them, beside the design's targets. Run from `packages/agent-edit`:
 *   pnpm exec tsx scripts/attribution-cost.ts
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { classifyChanges, type ItemRange } from "../src/diff/attribution.ts";
import { readBlocks } from "../src/diff/fragments.ts";
import { diffBlocks } from "../src/diff/hunks.ts";
import { projectReview } from "../src/diff/review.ts";

const schema = buildDocumentSchema();
const NAME = "prosemirror";

function chapter(words: number, perParagraph: number, changed: number) {
  const paragraphs = Array.from({ length: Math.ceil(words / perParagraph) }, (_, p) =>
    Array.from({ length: perParagraph }, (_, w) => `w${p}x${w}`).join(" "),
  );
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.topNodeType.create(
      null,
      paragraphs.map((t) => schema.nodes.paragraph.create(null, schema.text(t))),
    ),
    seed.getXmlFragment(NAME),
  );
  const base = readBlocks(seed.getXmlFragment(NAME), schema);
  const draft = new Y.Doc({ gc: false });
  draft.clientID = 9;
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(seed));
  const ai = new Y.Doc({ gc: false });
  ai.clientID = 2;
  Y.applyUpdate(ai, Y.encodeStateAsUpdate(draft));
  const deleted: ItemRange[] = [];
  ai.on("afterTransaction", (tr: Y.Transaction) => {
    for (const [c, items] of tr.deleteSet.clients)
      for (const d of items) deleted.push([c, d.clock, d.len]);
  });
  const before = Y.snapshot(ai).sv.get(2) ?? 0;
  // Edits run from the end of the document to its start, so earlier offsets stay valid.
  const edits: Array<[number, number]> = [];
  for (let e = 0; e < changed; e++) {
    const p = Math.min(paragraphs.length - 1, Math.floor((e * paragraphs.length) / changed));
    edits.push([p, 2 + 4 * (edits.filter(([q]) => q === p).length % Math.floor(perParagraph / 4))]);
  }
  ai.transact(() => {
    for (const [p, w] of edits.reverse()) {
      const text = (ai.getXmlFragment(NAME).get(p) as Y.XmlElement).get(0) as Y.XmlText;
      const words = paragraphs[p].split(" ");
      const at = words.slice(0, w).join(" ").length + 1;
      text.delete(at, words[w].length);
      text.insert(at, `EDIT${p}x${w}`);
    }
  });
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(ai));
  const after = Y.snapshot(ai).sv.get(2) ?? 0;
  const projection = projectReview(
    diffBlocks(base, readBlocks(draft.getXmlFragment(NAME), schema)),
  );
  const provenance = {
    userId: "u",
    parts: [
      {
        threadId: "t",
        turnId: "turn",
        inserted: [[2, before, after - before]] as ItemRange[],
        deleted,
      },
    ],
  };
  return { draft, projection, provenance };
}

/** `paragraphs` paragraphs of `words` alternating "ab" and "KEEP"; an AI part turns every "ab" into "az". */
function alternating(paragraphs: number, words: number) {
  const text = Array.from({ length: words }, (_, i) => (i % 2 ? "KEEP" : "ab")).join(" ");
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.topNodeType.create(
      null,
      Array.from({ length: paragraphs }, () =>
        schema.nodes.paragraph.create(null, schema.text(text)),
      ),
    ),
    seed.getXmlFragment(NAME),
  );
  const base = readBlocks(seed.getXmlFragment(NAME), schema);
  const draft = new Y.Doc({ gc: false });
  draft.clientID = 9;
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(seed));
  const ai = new Y.Doc({ gc: false });
  ai.clientID = 2;
  Y.applyUpdate(ai, Y.encodeStateAsUpdate(draft));
  const deleted: ItemRange[] = [];
  ai.on("afterTransaction", (tr: Y.Transaction) => {
    for (const [c, items] of tr.deleteSet.clients)
      for (const d of items) deleted.push([c, d.clock, d.len]);
  });
  ai.transact(() => {
    for (let p = 0; p < paragraphs; p++) {
      const t = (ai.getXmlFragment(NAME).get(p) as Y.XmlElement).get(0) as Y.XmlText;
      for (let at = text.length - 1; at >= 0; at--)
        if (text[at] === "b") {
          t.delete(at, 1);
          t.insert(at, "z");
        }
    }
  });
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(ai));
  const provenance = {
    userId: "u",
    parts: [
      {
        threadId: "t",
        turnId: "turn",
        inserted: [[2, 0, Y.snapshot(ai).sv.get(2) ?? 0]] as ItemRange[],
        deleted,
      },
    ],
  };
  const projection = projectReview(
    diffBlocks(base, readBlocks(draft.getXmlFragment(NAME), schema)),
  );
  return { draft, projection, provenance };
}

function median(run: () => void) {
  for (let i = 0; i < 3; i++) run();
  const samples = Array.from({ length: 9 }, () => {
    const t = performance.now();
    run();
    return performance.now() - t;
  }).sort((a, b) => a - b);
  return samples[4];
}

const shapes: Array<[string, number, number, number, number]> = [
  ["10,000 words, 50 changes (target 5 ms)", 10_000, 100, 50, 5],
  ["10,000 words, every paragraph changed (target 15 ms)", 10_000, 100, 100, 15],
  ["50,000 words, 50 changes (target 10 ms)", 50_000, 100, 50, 10],
  ["50,000 words, every paragraph changed (target 50 ms)", 50_000, 100, 500, 50],
  ["10,000 words in one paragraph, 50 changes (no target)", 10_000, 10_000, 50, 0],
];
// The reviewer's alternating shapes: every other word replaced, which the review merges into one change per paragraph.
const alternatingShapes: Array<[string, number, number]> = [
  ["five 2,000-word paragraphs, every other word replaced (target 15 ms)", 5, 2000],
  ["one 3,000-word paragraph, every other word replaced (target 15 ms)", 1, 3000],
];
// One throwaway chapter first, so the first printed row is not the one that pays for JIT warm-up.
{
  const warm = chapter(10_000, 100, 50);
  median(() => classifyChanges(warm.draft, warm.projection, warm.provenance));
}
for (const [name, paragraphs, words] of alternatingShapes) {
  const { draft, projection, provenance } = alternating(paragraphs, words);
  const ms = median(() => classifyChanges(draft, projection, provenance));
  const named = [...classifyChanges(draft, projection, provenance).values()].filter(
    (c) => c.byline.length,
  ).length;
  console.log(
    `${name}: ${ms.toFixed(2)} ms, ${projection.groups.length} changes, ${named} named${ms <= 15 ? ", within target" : ", OVER target"}`,
  );
}
for (const [name, words, per, changed, target] of shapes) {
  const { draft, projection, provenance } = chapter(words, per, changed);
  const ms = median(() => classifyChanges(draft, projection, provenance));
  const named = [...classifyChanges(draft, projection, provenance).values()].filter(
    (c) => c.byline.length,
  ).length;
  console.log(
    `${name}: ${ms.toFixed(2)} ms, ${projection.groups.length} changes, ${named} named${target ? (ms <= target ? ", within target" : ", OVER target") : ""}`,
  );
}

// The footprint is mandatory even when no precision work is allowed.
{
  const { draft, projection, provenance } = chapter(50_000, 100, 500);
  const run = () => classifyChanges(draft, projection, provenance, { budget: 0, record: true });
  const ms = median(run);
  const results = [...run().values()];
  const named = results.filter((change) => change.byline.length).length;
  const members = results.filter((change) => change.members.length).length;
  const recorded = results.filter(
    (change) => change.applied?.base.length && change.applied.settled.length,
  ).length;
  console.log(
    `50,000 words, every paragraph changed, budget 0: ${ms.toFixed(2)} ms, ${results.length} changes, ${named} named, ${members} members, ${recorded} recorded`,
  );
}
