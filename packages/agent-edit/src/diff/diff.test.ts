/**
 * The diff core's named risk: hunks that read as word salad.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Word-level hunk cleanup
 * - Where the tokenizer splits words (`segmentText`)
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it, vi } from "vitest";
import { diffBlocks, type Hunk } from "./hunks.js";
import { segmentText, type Tok } from "./tokens.js";

const schema = buildDocumentSchema();
const strong = schema.marks.strong.create();

const para = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const plain = (...texts: string[]) => texts.map(para);
const tokText = (toks: readonly Tok[]) =>
  toks.map((t) => (t.kind === "text" ? t.ws + t.core : t.kind)).join("");
const removed = (d: ReturnType<typeof diffBlocks>, h: Hunk) =>
  tokText(d.base.toks.slice(h.from, h.to));
const inserted = (h: Hunk) => tokText(h.ins);

// The browser and the server hash these segments into change ids: an engine-dependent split
// (ICU's `Intl.Segmenter`) made Apply name changes the server could not find.
it("splits words the same on every engine", () => {
  const show = (text: string) =>
    segmentText(text).map(({ segment, space, word }) =>
      space ? "_" : word ? segment : `·${segment}`,
    );
  expect(show("aph.TabOne e.g. file.txt don't 3.14")).toEqual([
    "aph",
    "·.",
    "TabOne",
    "_",
    "e",
    "·.",
    "g",
    "·.",
    "_",
    "file",
    "·.",
    "txt",
    "_",
    "don't",
    "_",
    "3",
    "·.",
    "14",
  ]);
  expect(show("我们去了。カーです สวัสดี")).toEqual([
    "我",
    "们",
    "去",
    "了",
    "·。",
    "カ",
    "ー",
    "で",
    "す",
    "_",
    "ส",
    "วั",
    "ส",
    "ดี",
  ]);
  expect(show("hi 👨‍👩‍👧 👍🏽 🇯🇵!")).toEqual([
    "hi",
    "_",
    "·👨‍👩‍👧",
    "_",
    "·👍🏽",
    "_",
    "·🇯🇵",
    "·!",
  ]);
});

describe("hunks read as edits, not word salad", () => {
  const rows: Array<{
    name: string;
    base: PMNode[];
    draft: PMNode[];
    expected: Array<{ removed: string; inserted: string }>;
  }> = [
    {
      name: "the bell sentence is one replacement (before/01)",
      base: plain("Three notes meant the road was safe"),
      draft: plain("Each clear note promised an empty road beyond the wall"),
      expected: [
        {
          removed: "Three notes meant the road was safe",
          inserted: "Each clear note promised an empty road beyond the wall",
        },
      ],
    },
    {
      name: "a single-word swap stays word-level",
      base: plain("The road was safe and quiet tonight"),
      draft: plain("The road was dangerous and quiet tonight"),
      expected: [{ removed: " safe", inserted: " dangerous" }],
    },
    {
      name: "cleanup never crosses a paragraph break",
      base: plain("alpha beta", "gamma delta"),
      draft: plain("ALPHA beta", "gamma DELTA"),
      expected: [
        { removed: "alpha", inserted: "ALPHA" },
        { removed: " delta", inserted: " DELTA" },
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
      expected: [{ removed: " two", inserted: " two" }],
    },
    {
      name: "a doubled space is whitespace",
      base: plain("one two three"),
      draft: plain("one  two three"),
      expected: [{ removed: " two", inserted: "  two" }],
    },
  ];
  it.each(rows)("$name", ({ base, draft, expected }) => {
    const d = diffBlocks(base, draft);
    expect(
      d.hunks.map((h) => ({
        removed: removed(d, h),
        inserted: inserted(h),
      })),
    ).toEqual(expected);
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
