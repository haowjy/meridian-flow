/** Streaming snapshots stay identical to the canonical whole-source Markdown parse. */

import type { Node as PMNode } from "prosemirror-model";
import { expect, it } from "vitest";

import { schema } from "./codec-test-support.js";
import { markdownCodec } from "./index.js";

const blocks = [
  "para",
  "- a",
  "> quote",
  "    code",
  "```js\na\n```",
  "~~~js\n*literal",
  "1. a",
  "[x]: https://example.com",
  "<div>\na\n</div>",
  "---",
  "- [ ] a",
  "> ```\na",
  "- ```\n  a",
  "[x]",
  "## head",
  "a\n#x",
  "  ### x",
  "| a | b |\n| --- | --- |\n| c\\\n d | e |",
] as const;

const fixtures = [
  ...blocks.flatMap((left) =>
    blocks.map((right) => `prefix\n\nprefix2\n\n${left}\n\n${right}\n\nend\n\nlast`),
  ),
  "~~~\n*literal\n~~~\noutside",
  "> ~~~\n> *literal\noutside",
  "- ```\n  a\n\npara",
  "> ```\n> code\n> ```\n\n| a | b |\n| --- | --- |\n| c\\\n d | e |",
  "\tcode\r\n\r\npara\r\n",
  "   ```js\ncode\n   ```\n\nafter",
  "`inline` *unfinished",
  "<div>\na\n\nb\n</div>\n\nafter",
  "[text][label]\n\n[label]: /url",
  "[label][]\n\n[LABEL]: /url",
  "[label]\n\n[  LaBeL  ]: /url",
  "[x]\n\n[x]: /first\n\n[X]: /second",
  "> [q]\n>\n> [q]: /quote",
  "- [l]\n\n  [l]: /list",
  "[a][not yet]\n\n[not yet]:",
  "a".repeat(400),
  Array.from({ length: 40 }, (_, index) => `- item ${index}`).join("\n"),
  `\`\`\`ts\n${"x".repeat(400)}`,
] as const;

const codec = markdownCodec({ schema });

it("keeps every streaming parse confined to the canonical last block", () => {
  const corpus = [
    ...fixtures,
    "[x]: /\ncode\n=\n*h",
    "\te\n1.\n\n--",
    "[**x**][q]\n\np\n\n> [q]:\n> /url",
    "| a | b |\n| - | - |\n| c\\\n d | e |\n\n[q]: /url\n\np\n\nlast\n\n[**x**][q]",
    "[x](a_*foo",
  ];
  for (const source of corpus) {
    for (let end = 0; end <= source.length; end++) {
      assertStreamingParse(source.slice(0, end));
    }
  }

  for (const source of fixtures.slice(-12)) {
    for (const size of [2, 7, 23]) {
      for (let end = size; end < source.length; end += size) {
        assertStreamingParse(source.slice(0, Math.min(end, source.length)));
      }
    }
  }
}, 30_000);

function assertStreamingParse(source: string): void {
  const canonical = codec.parse(source).blocks;
  const unrepaired = codec.parseStreaming(source);
  expect(nodesEqual(unrepaired.blocks, canonical), source).toBe(true);

  const repaired = codec.parseStreaming(source, { repair: true });
  expect(repaired.blocks.length, source).toBe(canonical.length);
  expect(nodesEqual(repaired.blocks.slice(0, -1), canonical.slice(0, -1)), source).toBe(true);
  expect(codeJson(repaired.blocks), source).toEqual(codeJson(canonical));
  if (repaired.openCode) {
    expect(codeNodes(repaired.blocks), source).toContainEqual(repaired.openCode);
  }
}

function nodesEqual(left: readonly PMNode[], right: readonly PMNode[]): boolean {
  return left.length === right.length && left.every((node, index) => right[index]?.eq(node));
}

function codeJson(blocks: readonly PMNode[]): unknown[] {
  return codeNodes(blocks).map((node) => node.toJSON());
}

function codeNodes(blocks: readonly PMNode[]): PMNode[] {
  const code: PMNode[] = [];
  for (const block of blocks) {
    if (block.type.name === "code_block") code.push(block);
    block.descendants((node) => {
      if (node.type.name === "code_block") code.push(node);
      return node.type.name !== "code_block";
    });
  }
  return code;
}
