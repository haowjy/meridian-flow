/**
The diff core's named risks: word salad in review and partial
 * Apply or Discard that corrupts text. Seeded, so a failure replays.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Word-level review hunk cleanup and edit categorization
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { describe, expect, it, vi } from "vitest";
import { applySpanPatches, composeHunks, type SpanPatch } from "./compose.js";
import { blocksEqual } from "./equal.js";
import { diffBlocks, type Hunk, hunkKind } from "./hunks.js";
import { projectReview } from "./review.js";
import type { Tok } from "./tokens.js";

const schema = buildDocumentSchema();
const strong = schema.marks.strong.create();
const em = schema.marks.em.create();

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]) => xs[int(xs.length)],
  };
}
type Rng = ReturnType<typeof rng>;

const para = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const plain = (...texts: string[]) => texts.map(para);
const tokText = (toks: readonly Tok[]) =>
  toks.map((t) => (t.kind === "text" ? t.ws + t.core : t.kind)).join("");
const removed = (d: ReturnType<typeof diffBlocks>, h: Hunk) =>
  tokText(d.base.toks.slice(h.from, h.to));
const inserted = (h: Hunk) => tokText(h.ins);

describe("review hunks read as edits, not word salad", () => {
  const rows: Array<{
    name: string;
    base: PMNode[];
    draft: PMNode[];
    expected: Array<{ kind: string; removed: string; inserted: string }>;
  }> = [
    {
      name: "the bell sentence is one replacement (before/01)",
      base: plain("Three notes meant the road was safe"),
      draft: plain("Each clear note promised an empty road beyond the wall"),
      expected: [
        {
          kind: "text",
          removed: "Three notes meant the road was safe",
          inserted: "Each clear note promised an empty road beyond the wall",
        },
      ],
    },
    {
      name: "a single-word swap stays word-level",
      base: plain("The road was safe and quiet tonight"),
      draft: plain("The road was dangerous and quiet tonight"),
      expected: [{ kind: "text", removed: " safe", inserted: " dangerous" }],
    },
    {
      name: "cleanup never crosses a paragraph break",
      base: plain("alpha beta", "gamma delta"),
      draft: plain("ALPHA beta", "gamma DELTA"),
      expected: [
        { kind: "text", removed: "alpha", inserted: "ALPHA" },
        { kind: "text", removed: " delta", inserted: " DELTA" },
      ],
    },
    {
      name: "a marks-only change is format",
      base: plain("one two three"),
      draft: [
        schema.nodes.paragraph.create(null, [
          schema.text("one "),
          schema.text("two", [strong]),
          schema.text(" three"),
        ]),
      ],
      expected: [{ kind: "format", removed: " two", inserted: " two" }],
    },
    {
      name: "a doubled space is whitespace",
      base: plain("one two three"),
      draft: plain("one  two three"),
      expected: [{ kind: "whitespace", removed: " two", inserted: "  two" }],
    },
  ];
  it.each(rows)("$name", ({ base, draft, expected }) => {
    const d = diffBlocks(base, draft);
    expect(
      d.hunks.map((h) => ({
        kind: hunkKind(d.base.toks, h),
        removed: removed(d, h),
        inserted: inserted(h),
      })),
    ).toEqual(expected);
  });
});

// ---------- random rich documents ----------
type Word = { t: string; sp: string; strong: boolean; em: boolean; spStrong: boolean };
type Blk = { type: "p" | "h" | "list" | "rule"; words: Word[] };
const VOCAB = [
  "red",
  "one",
  "two",
  "three",
  "road",
  "wall",
  "bell",
  "note",
  "dawn",
  "gate",
  "青山",
  "don't",
  "end.",
];

function randomWord(r: Rng, first = false): Word {
  return {
    t: r.pick(VOCAB),
    sp: first ? (r.chance(0.05) ? " " : "") : r.chance(0.12) ? "  " : " ",
    strong: r.chance(0.12),
    em: r.chance(0.08),
    spStrong: r.chance(0.05),
  };
}
const randomBlock = (r: Rng): Blk => ({
  type: r.pick(["p", "p", "p", "p", "h", "list", "rule"] as const),
  words: Array.from({ length: 1 + r.int(12) }, (_, i) => randomWord(r, i === 0)),
});

function toNode(b: Blk): PMNode {
  if (b.type === "rule") return schema.nodes.horizontal_rule.create();
  const pieces: Array<{ text: string; marks: Mark[] }> = [];
  const push = (text: string, marks: Mark[]) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last && last.marks.length === marks.length && last.marks.every((m, i) => m.eq(marks[i])))
      last.text += text;
    else pieces.push({ text, marks });
  };
  for (const w of b.words) {
    push(w.sp, w.spStrong ? [strong] : []);
    push(w.t, [...(w.strong ? [strong] : []), ...(w.em ? [em] : [])]);
  }
  const content = pieces.map((p) =>
    schema.text(p.text, schema.marks.strong.isInSet(p.marks) || p.marks.length ? p.marks : []),
  );
  if (b.type === "h") return schema.nodes.heading.create({ level: 2 }, content);
  const p = schema.nodes.paragraph.create(null, content);
  return b.type === "list"
    ? schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null, p))
    : p;
}

function mutate(r: Rng, blocks: Blk[]): Blk[] {
  const out: Blk[] = blocks.map((b) => ({ ...b, words: b.words.map((w) => ({ ...w })) }));
  for (let n = 1 + r.int(8); n > 0; n--) {
    if (!out.length) {
      out.push(randomBlock(r));
      continue;
    }
    const i = r.int(out.length);
    const b = out[i];
    const textual = b.type === "p" || b.type === "h";
    const w = r.int(Math.max(1, b.words.length));
    switch (r.int(11)) {
      case 0:
        if (textual && b.words[w]) b.words[w].t = r.pick(VOCAB);
        break;
      case 1:
        if (textual)
          b.words.splice(w, 0, ...Array.from({ length: 1 + r.int(3) }, () => randomWord(r)));
        break;
      case 2:
        if (textual) b.words.splice(w, 1 + r.int(3));
        break;
      case 3:
        if (textual && b.words[w]) b.words[w].strong = !b.words[w].strong;
        break;
      case 4:
        if (textual && b.words[w]) b.words[w].sp = b.words[w].sp === " " ? "  " : " ";
        break;
      case 5:
        if (textual && w > 0 && b.words.length > 1) {
          const tail = b.words.splice(w);
          tail[0].sp = "";
          out.splice(i + 1, 0, { type: "p", words: tail });
        }
        break;
      case 6:
        if (textual && out[i + 1]?.type === "p") {
          const next = out.splice(i + 1, 1)[0];
          if (next.words[0]) next.words[0].sp = " ";
          b.words.push(...next.words);
        }
        break;
      case 7:
        out.splice(i, 1);
        break;
      case 8:
        out.splice(r.int(out.length + 1), 0, randomBlock(r));
        break;
      case 9: {
        const [m] = out.splice(i, 1);
        out.splice(r.int(out.length + 1), 0, m);
        break;
      }
      default:
        if (b.type === "p" || b.type === "h") b.type = b.type === "p" ? "h" : "p";
    }
  }
  return out;
}

function untouchedOutside(base: PMNode[], patches: SpanPatch[], result: PMNode[]) {
  let b = 0;
  let r = 0;
  for (const p of [...patches].sort((x, y) => x.base.from - y.base.from)) {
    expect(p.base.from).toBeGreaterThanOrEqual(b);
    for (; b < p.base.from; b++, r++) expect(result[r]).toBe(base[b]);
    b = p.base.to;
    r += p.blocks.length;
  }
  for (; b < base.length; b++, r++) expect(result[r]).toBe(base[b]);
  expect(r).toBe(result.length);
}

describe("partial Apply and Discard never corrupt text", () => {
  it("composes exactly over random rich documents and random group selections", () => {
    const r = rng(20261013);
    let withChanges = 0;
    let partial = 0;
    for (let n = 0; n < 500; n++) {
      const baseModel = Array.from({ length: 1 + r.int(6) }, () => randomBlock(r));
      const base = baseModel.map(toNode);
      const draft = mutate(r, baseModel).map(toNode);
      const d = diffBlocks(base, draft);
      const ctx = `pair ${n}`;
      expect(d.hunks.length > 0, ctx).toBe(!blocksEqual(base, draft));
      if (!d.hunks.length) continue;
      withChanges++;
      const groups = projectReview(d).groups.map((g) => g.hunks.map((h) => d.hunks[h.index]));
      const all = groups.flat();

      const applyAll = composeHunks(schema, d, all, "apply");
      const got = applySpanPatches(base, applyAll, "base");
      expect(blocksEqual(got, draft), `${ctx} apply all`).toBe(true);
      expect(composeHunks(schema, d, [], "apply"), ctx).toEqual([]);
      const discardAll = composeHunks(schema, d, all, "discard");
      expect(
        blocksEqual(applySpanPatches(draft, discardAll, "draft"), base),
        `${ctx} discard all`,
      ).toBe(true);

      const chosen = groups.filter(() => r.chance(0.5));
      const set = chosen.flat();
      const rest = groups.filter((g) => !chosen.includes(g)).flat();
      if (chosen.length && rest.length) partial++;
      const applied = composeHunks(schema, d, set, "apply");
      const viaApply = applySpanPatches(base, applied, "base");
      const viaDiscard = applySpanPatches(draft, composeHunks(schema, d, rest, "discard"), "draft");
      expect(blocksEqual(viaApply, viaDiscard), `${ctx} apply(set) = discard(rest)`).toBe(true);
      untouchedOutside(base, applied, viaApply);
      const discarded = composeHunks(schema, d, set, "discard");
      untouchedOutside(
        draft,
        discarded.map((p) => ({ ...p, base: p.draft })),
        applySpanPatches(draft, discarded, "draft"),
      );
    }
    expect(withChanges).toBeGreaterThan(350);
    expect(partial).toBeGreaterThan(100);
  });

  it("composes two groups in one paragraph jointly", () => {
    const base = plain("red one two three four blue");
    const draft = plain("RED one two three four BLUE");
    const d = diffBlocks(base, draft);
    expect(d.hunks).toHaveLength(2);
    const both = composeHunks(schema, d, d.hunks, "apply");
    expect(both).toHaveLength(1);
    expect(blocksEqual(applySpanPatches(base, both, "base"), draft)).toBe(true);
    const first = applySpanPatches(base, composeHunks(schema, d, [d.hunks[0]], "apply"), "base");
    expect(first[0].textContent).toBe("RED one two three four blue");
    const discardSecond = applySpanPatches(
      draft,
      composeHunks(schema, d, [d.hunks[1]], "discard"),
      "draft",
    );
    expect(discardSecond[0].textContent).toBe("RED one two three four blue");
  });
});

// diff-match-patch reads `timeout || 1`: a "no timeout" of 0 was a one-second deadline. Under load, a diff cut
// short there was cached on its retained nodes and kept, so the same text reviewed differently warm and cold.
it("a diff computed under a slow clock matches the same text diffed fresh", () => {
  const hunksOf = (base: PMNode[], draft: PMNode[]) =>
    diffBlocks(base, draft).hunks.map((h) => ({
      from: h.from,
      to: h.to,
      sfrom: h.sfrom,
      ins: h.ins.map((t) => t.key),
    }));
  const baseText = "g a ! g . b ? f f d ? d . ! g ? c f . c . . g c ? f d g . ! d b d g b b";
  const draftText = "g ! g ? . g . b . c d f ! e a ! f d d ! ? ? . g . ? a ! e d";
  const base = plain(baseText);
  const draft = plain(draftText);
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));
  try {
    hunksOf(base, draft);
  } finally {
    clock.mockRestore();
  }
  expect(hunksOf(base, draft)).toEqual(hunksOf(plain(baseText), plain(draftText)));
});
