// Pins: a match found in a block's destination-free markdown lands on the same words in the real
// body. The risk is a match the model's excerpt and the app's door cannot locate; titled links
// and images broke it twice when the code re-derived link syntax by hand.
import { markdownCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";

import { bodyRange, destinationFreeBlocks } from "./grep-text.js";
import { markdownPlainText, markdownTextView } from "./markdown-text-view.js";

const codec = markdownCodec({ schema: buildDocumentSchema() });

const cases: Array<[name: string, markdown: string, target: string, inBody?: string]> = [
  ["titled link, match after", '[the hall](kb://a "Title") then TARGET', "TARGET"],
  ["titled link with <a b>", '[the hall](<kb://a b> "Title") then TARGET', "TARGET"],
  ["titled image", '![pic](kb://img.png "cap") and TARGET', "TARGET"],
  ["untitled link", "[the hall](kb://a) then TARGET", "TARGET"],
  ["destination with parentheses", "[the hall](kb://a\\(b\\)) then TARGET", "TARGET"],
  ["title after the match", '[the TARGET hall](kb://a "Title") then more', "TARGET"],
  [
    "match spanning the link",
    '[the hall](kb://a "Title") then TARGET',
    'hall]("Title") then',
    'hall](kb://a "Title") then',
  ],
  ["escaped text", "LIVE\\_ONLY [x](kb://a) and LIVE\\_ONLY", "LIVE_ONLY"],
  ["two links", '[a](kb://1 "t") [b](<kb://2 x>) [c](kb://3) TARGET', "TARGET"],
];

describe("bodyRange", () => {
  it.each(cases)("%s", (_name, markdown, target, inBody = target) => {
    const blocks = codec.parse(markdown).blocks;
    const body = codec.serializeBlocks(blocks, UNSCOPED_DOCUMENT_LINKS)[0] as string;
    const free = destinationFreeBlocks(codec, blocks)[0] as string;
    const view = markdownTextView(free);
    // The last occurrence, so a link comes before it.
    const at = view.text.lastIndexOf(target);
    const range = bodyRange(codec, free, body, {
      start: view.start[at] as number,
      end: view.end[at + target.length - 1] as number,
    });
    expect(range).not.toBeNull();
    const { start, end } = range as { start: number; end: number };
    expect(markdownPlainText(body.slice(start, end))).toBe(inBody);
  });
});
