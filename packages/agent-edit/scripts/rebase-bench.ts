/**
 * Merge and Yjs-write timing at chapter scale (not a test): `pnpm exec tsx scripts/rebase-bench.ts`.
 * Synthetic prose with a Zipf vocabulary so common words repeat; edits spread across the chapter on both
 * sides, plus a heavy-rewrite case. Median of 5 on this machine (spec-content-rebase.md section 10).
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { pmToY, readBlocks, rebase, writeBlocks } from "../src/diff/index.js";
import { Rng } from "../src/diff/merge.fixtures.js";

const schema = buildDocumentSchema();
const FRAG = "prosemirror";

const COMMON =
  "the and of to a in he his was that it with as at on for her she had but by from not they qi sect elder sword said".split(
    " ",
  );

function vocab(rng: Rng): () => string {
  const rare = Array.from(
    { length: 4000 },
    (_, i) => `${"lmnrstkv"[i % 8]}${"aeiou"[i % 5]}${i.toString(36)}`,
  );
  return () =>
    rng.chance(0.45)
      ? COMMON[Math.floor(rng.next() ** 2 * COMMON.length)]
      : rare[Math.floor(rng.next() ** 1.5 * rare.length)];
}

function chapter(schema: Schema, rng: Rng, words: number): PMNode[] {
  const word = vocab(rng);
  const out: PMNode[] = [];
  let n = 0;
  while (n < words) {
    const len = 15 + rng.int(60);
    const ws: string[] = [];
    for (let k = 0; k < len; k++) ws.push(word() + (rng.chance(0.1) ? "." : ""));
    n += len;
    out.push(
      rng.chance(0.02)
        ? schema.nodes.heading.create({ level: 2 }, schema.text(ws.slice(0, 5).join(" ")))
        : schema.nodes.paragraph.create(null, schema.text(`${ws.join(" ")}.`)),
    );
  }
  return out;
}

function edit(
  schema: Schema,
  doc: PMNode[],
  rng: Rng,
  n: number,
  tag: string,
  structural: boolean,
): PMNode[] {
  const out = [...doc];
  for (let k = 0; k < n; k++) {
    const i = rng.int(out.length);
    const b = out[i];
    if (!b.isTextblock || !b.textContent) continue;
    const ws = b.textContent.split(" ");
    const j = rng.int(ws.length);
    const r = rng.next();
    if (r < 0.4) ws[j] = `${tag}${k}`;
    else if (r < 0.7) ws.splice(j, 0, `${tag}${k}a`, `${tag}${k}b`);
    else ws.splice(j, 1);
    out[i] = b.type.create(b.attrs, ws.join(" ") ? schema.text(ws.join(" ")) : undefined);
  }
  if (structural) {
    const i = rng.int(out.length - 1);
    const t = out[i].textContent.split(" ");
    const h = Math.floor(t.length / 2);
    out.splice(
      i,
      1,
      schema.nodes.paragraph.create(null, schema.text(t.slice(0, h).join(" "))),
      schema.nodes.paragraph.create(null, schema.text(t.slice(h).join(" "))),
    );
    const from = rng.int(out.length);
    const [moved] = out.splice(from, 1);
    out.splice(rng.int(out.length), 0, moved);
  }
  return out;
}

function median(xs: number[]) {
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

function perf() {
  console.log("\n== Timing (Node, this machine; median of 5)");
  for (const words of [10_000, 50_000]) {
    for (const [label, nL, nD, heavy] of [
      ["spread: 20 live + 20 draft word edits, a split and a move each", 20, 20, false],
      ["heavy: 300 live + 600 draft word edits", 300, 600, false],
    ] as const) {
      const times: number[] = [];
      const ywrite: number[] = [];
      let conflicts = 0;
      for (let s = 0; s < 5; s++) {
        const rng = new Rng(1000 + s);
        const base = chapter(schema, rng, words);
        const live = edit(schema, base, rng, nL, "L", !heavy);
        const draft = edit(schema, base, rng, nD, "D", !heavy);
        const t0 = performance.now();
        const r = rebase(schema, base, live, draft);
        times.push(performance.now() - t0);
        conflicts += r.conflicts.length;
        const doc = new Y.Doc();
        doc.getXmlFragment(FRAG).insert(0, draft.map(pmToY));
        const t1 = performance.now();
        doc.transact(() => writeBlocks(doc.getXmlFragment(FRAG), schema, r.blocks));
        ywrite.push(performance.now() - t1);
        if (s === 0 && readBlocks(doc.getXmlFragment(FRAG), schema).length !== r.blocks.length)
          console.log("   ! write mismatch");
      }
      console.log(
        `   ${words / 1000}k words, ${label}: merge ${median(times).toFixed(1)} ms, Yjs write ${median(ywrite).toFixed(1)} ms, conflicts/run ${(conflicts / 5).toFixed(1)}`,
      );
    }
  }
}

perf();
