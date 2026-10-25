/**
 * The review projection's named risks: a move half-applied (duplicated or lost paragraph), ids that
 * churn when an unrelated change appears, and draft positions that decorate the wrong text.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Stable review grouping, move pairing, and draft mapping (kb/decisions/collab/drafts/review/draft-live-content-rebase.md)
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { applySpanPatches } from "./compose.js";
import { blocksEqual } from "./equal.js";
import { diffBlocks } from "./hunks.js";
import { composeGroups, projectReview } from "./review.js";

const schema = buildDocumentSchema();
const para = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const doc = (texts: string[]) => texts.map(para);
const textOf = (blocks: readonly PMNode[]) => blocks.map((b) => b.textContent);
const project = (base: string[], draft: string[]) =>
  projectReview(diffBlocks(doc(base), doc(draft)));

// Each paragraph opens with a distinct marker word so a copy or a loss is countable.
const A = "Alpha lantern drifts over quiet water tonight";
const B = "Bravo kettle hums beside the cold window";
const C = "Charlie harbor wakes before the pale sunrise";
const D = "Delta orchard hides under heavy summer rain";
const E = "Echo foxes cross the frozen valley road";
const F = "Foxtrot pilgrims carry salt across the dunes";
const G = "Golf signal fires climb the northern ridge";
const MARKERS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];

const rows: Array<{
  name: string;
  base: string[];
  draft: string[];
  groups: number;
  kinds?: string[];
}> = [
  {
    name: "an edit either side of a paragraph break joins",
    base: [A, B],
    draft: [A.replace("tonight", "TONIGHT"), B.replace("Bravo", "BRAVO")],
    groups: 1,
  },
  {
    name: "edits two unchanged words apart join",
    base: ["one two three four five six seven"],
    draft: ["ONE two three FOUR five six seven"],
    groups: 1,
  },
  {
    name: "edits three unchanged words apart stay separate",
    base: ["one two three four five six seven"],
    draft: ["ONE two three four FIVE six seven"],
    groups: 2,
  },
  {
    name: "an exact move is one group",
    base: [A, B, C, D],
    draft: [B, C, D, A],
    groups: 1,
    kinds: ["move"],
  },
  {
    name: "a moved and edited paragraph is one group",
    base: [A, B, C, D],
    draft: [B, C, D, A.replace("quiet", "restless")],
    groups: 1,
    kinds: ["move"],
  },
  {
    name: "a move next to an edit joins it",
    base: [A, B, C, D],
    draft: [B.replace("Bravo", "BRAVO"), C, D, A],
    groups: 1,
    kinds: ["move"],
  },
  {
    name: "two chained moves are one group",
    base: [A, B, C, D, E, F],
    draft: [C, D, B, E, F, A],
    groups: 1,
    kinds: ["move"],
  },
  {
    name: "a move and a distant edit stay two groups",
    base: [A, B, C, D, E, F, G],
    draft: [B, C, D.replace("heavy", "light"), E, F, G, A],
    groups: 2,
  },
];

describe("grouping and moves never half-apply", () => {
  it.each(rows)("$name", ({ base, draft, groups, kinds }) => {
    const p = project(base, draft);
    const b = doc(base);
    const d = doc(draft);
    expect(p.groups).toHaveLength(groups);
    if (kinds) expect(p.groups.map((g) => g.kind)).toEqual(kinds);
    expect(p.hasChanges).toBe(!blocksEqual(b, d));

    const all = p.groups.map((g) => g.id);
    expect(applySpanPatches(b, composeGroups(schema, p, all, "apply"), "base")).toSatisfy(
      (r: PMNode[]) => blocksEqual(r, d),
    );
    expect(applySpanPatches(d, composeGroups(schema, p, all, "discard"), "draft")).toSatisfy(
      (r: PMNode[]) => blocksEqual(r, b),
    );

    for (const g of p.groups) {
      const applied = textOf(
        applySpanPatches(b, composeGroups(schema, p, [g.id], "apply"), "base"),
      );
      const discarded = textOf(
        applySpanPatches(d, composeGroups(schema, p, [g.id], "discard"), "draft"),
      );
      for (const m of MARKERS) {
        const inDoc = base.some((t) => t.toLowerCase().startsWith(m.toLowerCase()));
        for (const result of [applied, discarded])
          expect(
            result.filter((t) => t.toLowerCase().startsWith(m.toLowerCase())).length,
            `${m} in ${result.join("|")}`,
          ).toBe(inDoc ? 1 : 0);
      }
    }
  });
});

describe("group ids", () => {
  const base = [A, B, C, D, E, F, G];
  const draft = [
    A.replace("quiet", "calm"),
    B,
    C,
    D.replace("heavy", "light"),
    E,
    F,
    G.replace("ridge", "pass"),
  ];
  const ids = (d: string[]) => project(base, d).groups.map((g) => g.id);

  it("an unrelated write keeps every other id, and a write inside one group changes only that id", () => {
    const before = ids(draft);
    expect(before).toHaveLength(3);
    const elsewhere = draft.slice();
    elsewhere[5] = F.replace("salt", "grain");
    const afterElsewhere = ids(elsewhere);
    expect(afterElsewhere).toHaveLength(4);
    for (const id of before) expect(afterElsewhere).toContain(id);

    const inside = draft.slice();
    inside[3] = D.replace("heavy", "gentle");
    const afterInside = ids(inside);
    expect(afterInside).toHaveLength(3);
    expect(afterInside.filter((id) => before.includes(id))).toEqual([before[0], before[2]]);
  });

  it("the same edit made twice gets distinct ids", () => {
    const twin = "same words here and there";
    const g = project(
      [twin, A, B, C, D, twin],
      [twin.replace("same", "SAME"), A, B, C, D, twin.replace("same", "SAME")],
    );
    expect(new Set(g.groups.map((x) => x.id)).size).toBe(2);
  });
});

describe("draft positions", () => {
  it("keeps a moved block separate from an adjacent paragraph-ending replacement", () => {
    const base = [
      "The crane watched the silent valley.",
      "Lin held a copper token beneath the old gate.",
      "Beyond the bridge, the river carried fallen leaves.",
    ];
    const draft = [
      base[0].replace("silent valley", "roaring canyon"),
      base[2],
      base[1].replace("copper token", "silver compass"),
    ];
    const p = project(base, draft);
    const d = schema.topNodeType.create(null, doc(draft));
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].kind).toBe("move");
    const hunks = p.groups[0].hunks;
    expect(hunks).toHaveLength(3);
    expect(hunks[0].removed).toEqual([{ type: "text", text: " silent valley" }]);
    const inline = hunks[0].inserted;
    expect(inline && d.textBetween(inline.from, inline.to)).toBe(" roaring canyon");
    expect(hunks[1].removed).toEqual([para(base[1]).toJSON()]);
    expect(hunks[1].inserted).toBeNull();
    expect(hunks[1].anchor).toBe(p.blockStarts[1]);
    expect(hunks[2].removed).toEqual([]);
    expect(hunks[2].inserted).toEqual({ from: p.blockStarts[2], to: d.content.size - 1 });
    const ids = p.groups.map((g) => g.id);
    expect(
      textOf(applySpanPatches(doc(base), composeGroups(schema, p, ids, "apply"), "base")),
    ).toEqual(draft);
    expect(
      textOf(applySpanPatches(doc(draft), composeGroups(schema, p, ids, "discard"), "draft")),
    ).toEqual(base);
  });

  it("green covers exactly the inserted text and the red anchor sits at a removed block", () => {
    const base = [A, B, C];
    const draft = [A, C.replace("harbor", "dangerous harbor")];
    const p = project(base, draft);
    const d = schema.topNodeType.create(null, doc(draft));
    const text = p.groups
      .flatMap((g) => g.hunks)
      .map((h) => h.inserted && d.textBetween(h.inserted.from, h.inserted.to));
    expect(text).toContain(" dangerous");
    const removal = p.groups
      .flatMap((g) => g.hunks)
      .find((h) => !h.inserted && h.removed[0]?.type === "paragraph");
    expect(removal?.anchor).toBe(p.blockStarts[1]);
    expect(removal?.removed[0].content[0].text).toBe(B);
    expect(p.groups[0].excerpt.inserted).toContain("dangerous");
  });
});
