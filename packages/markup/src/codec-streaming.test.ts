/** Streaming snapshots stay identical to the canonical whole-source Markdown parse. */

import type { Node as PMNode } from "prosemirror-model";
import { expect, it } from "vitest";

import { schema } from "./codec-test-support.js";
import { type MarkdownStreamSnapshot, markdownCodec } from "./index.js";

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

it("keeps every streamed prefix equivalent to the canonical parse", () => {
  for (const source of fixtures) {
    let snapshot: MarkdownStreamSnapshot | null = null;
    for (let end = 0; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      snapshot = codec.stream(snapshot, prefix);
      expect(nodesEqual(snapshot.blocks, codec.parse(prefix).blocks), prefix).toBe(true);
    }
  }

  for (const source of fixtures.slice(-12)) {
    for (const size of [2, 7, 23]) {
      let snapshot: MarkdownStreamSnapshot | null = null;
      for (let end = 0; end < source.length; end += size) {
        const prefix = source.slice(0, Math.min(end + size, source.length));
        snapshot = codec.stream(snapshot, prefix);
        expect(nodesEqual(snapshot.blocks, codec.parse(prefix).blocks), prefix).toBe(true);
      }
    }
  }

  for (const source of [
    "hello *unfinished",
    "~~~\n*literal\n~~~\noutside",
    "> ~~~\n> *literal\noutside",
    "`inline` *unfinished",
    "```\n*literal",
    "<div>\n*literal",
  ]) {
    const snapshot = codec.stream(null, source, { repair: true });
    expect(codeJson(snapshot.blocks), source).toEqual(codeJson(codec.parse(source).blocks));
    expect(snapshot.displaySource.startsWith(source), source).toBe(true);
    expect(
      codec.stream(snapshot, source).blocks.map((node) => node.toJSON()),
      source,
    ).toEqual(codec.parse(source).blocks.map((node) => node.toJSON()));
  }
}, 30_000);

function nodesEqual(left: readonly PMNode[], right: readonly PMNode[]): boolean {
  return left.length === right.length && left.every((node, index) => right[index]?.eq(node));
}

function codeJson(blocks: readonly PMNode[]): unknown[] {
  const code: unknown[] = [];
  for (const block of blocks) {
    if (block.type.name === "code_block") code.push(block.toJSON());
    block.descendants((node) => {
      if (node.type.name === "code_block") code.push(node.toJSON());
      return node.type.name !== "code_block";
    });
  }
  return code;
}
