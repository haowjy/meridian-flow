/**
 * The merge's named risks: a silent loss, invention, duplication or resurrection of a word, and the
 * case table's regressions. Seeded, so a failure replays.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { blocksEqual } from "./equal.js";
import {
  CASES,
  check,
  type GBlock,
  type GenOptions,
  genScenario,
  limitations,
  parseDoc,
  Rng,
  render,
  resetWords,
  type Scenario,
  toPM,
} from "./merge.fixtures.js";
import { rebase } from "./merge.js";
import { similarity } from "./tokens.js";

const schema = buildDocumentSchema();

/** Idempotence and the degenerate cases every merge must get exactly right. */
function metaChecks(B: PMNode[], L: PMNode[], D: PMNode[], M: readonly PMNode[]): string[] {
  const out: string[] = [];
  const again = rebase(schema, L, L, [...M]);
  if (!blocksEqual(again.blocks, M) || again.conflicts.length)
    out.push("not idempotent: rebase(live, live, merged) changed the draft");
  if (!blocksEqual(rebase(schema, B, B, D).blocks, D)) out.push("no live change altered the draft");
  if (!blocksEqual(rebase(schema, B, L, B).blocks, L))
    out.push("untouched draft did not become live");
  const same = rebase(schema, B, L, L);
  if (!blocksEqual(same.blocks, L) || same.conflicts.length)
    out.push("identical changes did not collapse");
  return out;
}

/** A side moved a paragraph and rewrote most of it: by content a deletion plus a new paragraph (spec section 9). */
function rewrittenMove(sc: Scenario): boolean {
  const base = toPM(schema, sc.base);
  for (const [script, doc] of [
    [sc.liveScript, sc.live],
    [sc.draftScript, sc.draft],
  ] as const) {
    const pm = toPM(schema, doc);
    for (const id of script.moved) {
      const k = doc.findIndex((b: GBlock) => b.origins.includes(id));
      const bi = sc.base.findIndex((b) => b.origins.includes(id));
      if (k < 0 || bi < 0) continue;
      if (doc[k].origins.length > 1 || similarity(base[bi], pm[k]) < 0.5) return true;
    }
  }
  return false;
}

/** Text-level failures: a word lost, invented, duplicated or brought back. The rest is placement. */
const isSafety = (f: string) =>
  !/^(order|blocks|block type|em on|strong on|conflict on blocks)/.test(f);

describe("rebase", () => {
  it("coalesces a shared insertion beside a replacement, then preserves a dependent deletion", () => {
    const base = parseDoc(schema, "p:The cat sat on the mat.");
    const live = parseDoc(schema, "p:A big black cat sat on the mat.");
    const patched = parseDoc(schema, "p:The big black cat sat on the mat.");
    const merged = rebase(schema, base, live, patched).blocks;
    expect(blocksEqual(merged, live)).toBe(true);
    const deleted = parseDoc(schema, "p:The big cat sat on the mat.");
    expect(
      blocksEqual(
        rebase(schema, patched, merged, deleted).blocks,
        parseDoc(schema, "p:A big cat sat on the mat."),
      ),
    ).toBe(true);
  });

  it("keeps an untouched first move match when a later equal source was edited", () => {
    const [base, live, draft] = ["p:a b z a", "p:b a z", "p:a b z X"].map((text) =>
      parseDoc(schema, text),
    );
    const result = rebase(schema, base, live, draft);
    expect(render(result.blocks)).toBe("p:b a z X");
    expect(result.conflicts).toEqual([]);
    expect(result.orderConflict).toBe(false);
  });

  it.each(CASES.map((c) => [c.name, c] as const))("case table: %s", (_name, c) => {
    const [B, L, D] = [c.base, c.live, c.draft].map((x) => parseDoc(schema, x));
    const r = rebase(schema, B, L, D);
    expect(render(r.blocks)).toBe(c.merged);
    expect(r.conflicts).toHaveLength(c.conflicts);
    expect(
      check({
        base: B,
        live: L,
        draft: D,
        merged: r.blocks,
        conflicts: r.conflicts,
        orderConflict: r.orderConflict,
      }),
    ).toEqual([]);
  });

  // Risk: a concurrent edit script drops, invents, duplicates or resurrects a word, or breaks
  // idempotence, identical-change collapse or the degenerate cases. Placement misses outside the
  // spec's envelope (section 9) are excluded; safety failures inside it are not allowed.
  it("keeps every word across 200 seeded concurrent edit scripts", () => {
    const suites: GenOptions[] = [
      {},
      { ops: ["replaceWord", "insertWords", "deleteWords", "toggleMark"] },
      {
        ops: [
          "split",
          "merge",
          "moveBlock",
          "insertBlock",
          "deleteBlock",
          "setType",
          "replaceWord",
          "insertWords",
        ],
        moveP: 0.3,
      },
      { repeats: true },
    ];
    const failures: string[] = [];
    for (let i = 0; i < 200; i++) {
      const seed = 1 + i;
      resetWords();
      const sc = genScenario(new Rng(seed), suites[i % suites.length]);
      const [B, L, D] = [toPM(schema, sc.base), toPM(schema, sc.live), toPM(schema, sc.draft)];
      const r = rebase(schema, B, L, D);
      const rng = new Rng(seed ^ 0x9e3779b9);
      const fails = [
        ...check(
          {
            base: B,
            live: L,
            draft: D,
            merged: r.blocks,
            conflicts: r.conflicts,
            orderConflict: r.orderConflict,
            ambiguous: sc.copied,
          },
          () => rng.next(),
        ),
        ...metaChecks(B, L, D, r.blocks),
      ];
      const inEnvelope = !limitations(sc).length && !rewrittenMove(sc);
      const real = inEnvelope
        ? fails.filter(isSafety)
        : fails.filter((f) => /idempotent|collapse|altered|became/.test(f));
      if (real.length) failures.push(`seed ${seed}: ${real.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });
});
