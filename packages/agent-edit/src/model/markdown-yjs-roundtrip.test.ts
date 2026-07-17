import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";

import { prosemirrorRootOf, yProsemirrorModel } from "./y-prosemirror.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
const model = yProsemirrorModel(schema);

const longParagraph = Array.from({ length: 360 }, (_, index) => {
  const n = index + 1;
  return `word${n} cultivation arc memory thread`;
}).join(" ");

type Case = {
  name: string;
  markdown: string;
};

const passCases: Case[] = [
  { name: "empty doc", markdown: "" },
  { name: "heading", markdown: "# Chapter One\n" },
  {
    name: "bold italic inline code link image",
    markdown:
      'Plain **bold**, *italic*, `code()`, [portal](https://example.com "Portal"), and ![map](map.png "Map").\n',
  },
  { name: "strikethrough", markdown: "This is ~~removed~~ text.\n" },
  {
    name: "strikethrough combined with bold inside a sentence",
    markdown: "This is ~~removed with **bold** inside~~ text.\n",
  },
  { name: "unordered list", markdown: "- alpha\n- beta\n- gamma\n" },
  { name: "ordered list", markdown: "1. alpha\n2. beta\n3. gamma\n" },
  {
    name: "nested mixed list",
    markdown: "- outer\n  - inner bullet\n  1. inner ordered\n- after\n",
  },
  { name: "task list", markdown: "- [x] Draft\n- [ ] Revise\n" },
  {
    name: "mixed task and regular list items",
    markdown: "- [x] a\n- plain\n- [ ] b\n",
  },
  { name: "blockquote", markdown: "> quoted line\n> second line\n" },
  { name: "nested blockquote", markdown: "> outer\n>\n> > inner\n" },
  { name: "fenced code language", markdown: "```ts\nconst chi = 9;\nconsole.log(chi);\n```\n" },
  {
    name: "table alignment",
    markdown: "| Left | Center | Right |\n| :--- | :----: | ----: |\n| a    |    b   |     c |\n",
  },
  {
    name: "table with empty cell",
    markdown: "| A | B |\n| - | - |\n| a |   |\n",
  },
  {
    name: "table with escaped pipe in cell text",
    markdown: "| A           | B |\n| ----------- | - |\n| has \\| pipe | b |\n",
  },
  {
    name: "table with mixed alignment",
    markdown: "| Left | Plain | Right |\n| :--- | ----- | ----: |\n| a    | b     |     c |\n",
  },
  { name: "horizontal rule", markdown: "Before\n\n---\n\nAfter\n" },
  { name: "hard line break", markdown: "line one\\\nline two\n" },
  {
    name: "mixed long paragraphs",
    markdown:
      "The sect elder raised one brow, then wrote **three rules** in the dust. The first was simple: never trust a silent auction. The second was worse.\n\n" +
      "When dawn came, Mei counted 1,024 spirit stones, `two` broken seals, and a promise she had not meant to make.\n",
  },
  { name: "multi-thousand-word doc", markdown: `${longParagraph}\n\n${longParagraph}\n` },
];

const acceptedNormalizationCases: Case[] = [
  {
    name: "escaped punctuation drops redundant prose backslashes but keeps stable semantics",
    markdown: "Escaped \\*stars\\*, \\[brackets\\], and \\# hash.\n",
  },
  {
    name: "table cell padding canonicalizes after first round-trip",
    markdown: "| Stat | Value |\n| :-- | --: |\n| Strength | 128 |\n",
  },
  {
    name: "ragged table rows pad to the header width after first round-trip",
    markdown: "| A | B |\n| - | - |\n| a |\n",
  },
];

type DegradationCase = Case & {
  expectedFragments: readonly string[];
};

const deliberatelyUnsupportedCases: DegradationCase[] = [
  {
    name: "footnote",
    markdown: "A claim.[^1]\n\n[^1]: Supporting note.\n",
    expectedFragments: ["[^1]", "Supporting note."],
  },
  {
    name: "frontmatter",
    markdown: "---\ntitle: Chapter One\ntags:\n  - xianxia\n---\n\nOpening line.\n",
    expectedFragments: ["Chapter One", "Opening line."],
  },
  {
    name: "raw inline html",
    markdown: 'Text with <span data-x="1">inline</span> html.\n',
    expectedFragments: ["inline"],
  },
  {
    name: "raw block html",
    markdown: "<aside>\nRaw block.\n</aside>\n",
    expectedFragments: ["Raw block."],
  },
];

describe("markdown → Yjs → markdown fidelity", () => {
  describe("supported markdown surface", () => {
    for (const testCase of passCases) {
      it(`round-trips ${testCase.name}`, () => {
        expect(normalizeMarkdown(roundTrip(testCase.markdown))).toBe(
          normalizeMarkdown(testCase.markdown),
        );
      });
    }
  });

  describe("accepted markdown normalization", () => {
    for (const testCase of acceptedNormalizationCases) {
      it(testCase.name, () => {
        const output = roundTrip(testCase.markdown);
        const normalizedOutput = normalizeMarkdown(output);

        if (testCase.name.includes("prose backslashes")) {
          expect(normalizedOutput).toBe(
            normalizeMarkdown(normalizeProseEscapes(testCase.markdown)),
          );
        }
        // GFM canonicalizes table cell padding and pads ragged rows to the header width.
        // Content, cell structure, and column alignment are preserved, so this is
        // semantically lossless but not byte-identical to loosely-formatted source.
        expect(normalizeMarkdown(roundTrip(output))).toBe(normalizedOutput);
      });
    }
  });

  describe("deliberately unsupported markdown extensions", () => {
    for (const testCase of deliberatelyUnsupportedCases) {
      it(`degrades ${testCase.name} without throwing and then stays stable`, () => {
        const output = roundTrip(testCase.markdown);
        const normalizedOutput = normalizeMarkdown(output);

        for (const fragment of testCase.expectedFragments) {
          expect(normalizedOutput).toContain(fragment);
        }
        expect(normalizeMarkdown(roundTrip(output))).toBe(normalizedOutput);
      });
    }
  });
});

function roundTrip(markdown: string): string {
  const parsed = codec.parse(markdown);
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(doc, null, parsed);
  const root = prosemirrorRootOf(doc, schema);
  const blocks = Array.from({ length: root.childCount }, (_, index) => root.child(index));
  return codec.serialize(blocks);
}

function normalizeMarkdown(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function normalizeProseEscapes(markdown: string): string {
  // The serializer drops redundant `\#` and `\]` in prose here while keeping
  // `\*` and `\[` escaped so they continue to render as literal characters.
  return markdown.replace(/\\([#\]])/g, "$1");
}
