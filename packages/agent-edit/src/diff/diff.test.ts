/**
 * The diff core's named risks: one text split into words differently by the browser and the server,
 * and a diff cut short by a deadline and cached.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Where the tokenizer splits words (`segmentText`)
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { expect, it, vi } from "vitest";
import { align } from "./align.js";
import { correspond } from "./correspond.js";
import { buildSide, segmentText } from "./tokens.js";

const schema = buildDocumentSchema();
const para = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const plain = (...texts: string[]) => texts.map(para);

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

// diff-match-patch reads `timeout || 1`: a "no timeout" of 0 was a one-second deadline. Under load, a diff cut
// short there was cached on its retained nodes and kept, so the same text merged differently warm and cold.
it("a diff computed under a slow clock matches the same text diffed fresh", () => {
  const hunksOf = (base: PMNode[], draft: PMNode[]) =>
    align(buildSide(base), buildSide(draft), correspond(base, draft, { byId: true })).hunks.map(
      (h) => ({
        from: h.from,
        to: h.to,
        sfrom: h.sfrom,
        ins: h.ins.map((t) => t.key),
      }),
    );
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
