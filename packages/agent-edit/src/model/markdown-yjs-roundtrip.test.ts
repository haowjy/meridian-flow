import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";

import { prosemirrorRootOf, yProsemirrorModel } from "./y-prosemirror.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
const model = yProsemirrorModel(schema);

type Case = {
  name: string;
  markdown: string;
};

const passCases: Case[] = [
  { name: "empty doc", markdown: "" },
  {
    name: "bold italic inline code link image",
    markdown:
      'Plain **bold**, *italic*, `code()`, [portal](https://example.com "Portal"), and ![map](map.png "Map").\n',
  },
  {
    name: "nested mixed list",
    markdown: "- outer\n  - inner bullet\n  1. inner ordered\n- after\n",
  },
  {
    name: "mixed task and regular list items",
    markdown: "- [x] a\n- plain\n- [ ] b\n",
  },
  { name: "nested blockquote", markdown: "> outer\n>\n> > inner\n" },
  { name: "fenced code language", markdown: "```ts\nconst chi = 9;\nconsole.log(chi);\n```\n" },
];

const acceptedNormalizationCases: Case[] = [
  {
    name: "table with mixed alignment canonicalizes to HTML after first round-trip",
    markdown: "| Left | Plain | Right |\n| :--- | ----- | ----: |\n| a    | b     |     c |\n",
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

        // Tables normalize to the canonical HTML spelling in one pass. Content,
        // cell structure, and column alignment remain semantically lossless.
        expect(normalizeMarkdown(roundTrip(output))).toBe(normalizedOutput);
        expect(prosemirrorReadbackJson(testCase.markdown)).toEqual(
          prosemirrorJson(testCase.markdown),
        );
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

function prosemirrorJson(markdown: string): unknown {
  return schema.node("doc", null, codec.parse(markdown).blocks).toJSON();
}

function prosemirrorReadbackJson(markdown: string): unknown {
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(doc, null, codec.parse(markdown));
  return prosemirrorRootOf(doc, schema).toJSON();
}
