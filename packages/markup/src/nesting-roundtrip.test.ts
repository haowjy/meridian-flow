/**
 * Any block sequence the nesting attributes can express writes to Markdown that parses to
 * blocks which write the same text. The risk it guards is a state two writers can produce that
 * cannot be written or read back.
 *
 * A block that opens two lists at once (`- - text`) has no block for the outer item, so the
 * first read adds an empty paragraph for it; the check starts from the first read.
 */
import { describe, expect, it } from "vitest";
import { components, schema, t } from "./codec-test-support.js";
import { markdownCodec, mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "./index.js";

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function randomBlocks(random: () => number) {
  const count = 1 + Math.floor(random() * 10);
  return Array.from({ length: count }, (_, index) => {
    let path = "";
    for (let depth = Math.floor(random() * 4); depth > 0; depth--) {
      path += (random() < 0.15 ? "|" : "") + (random() < 0.3 ? ">" : "-");
    }
    const nesting = {
      path: path || null,
      kind: random() < 0.4 ? "ordered" : null,
      marker: pick(random, [null, "item", "item", "todo", "done"]),
      start: pick(random, [null, null, 3, 0, 999_999_998, 999_999_999, 1_000_000_000]),
      loose: random() < 0.2 ? true : null,
    };
    const word = `w${index}`;
    switch (
      pick(random, ["paragraph", "paragraph", "paragraph", "code", "rule", "level", "empty"])
    ) {
      case "code":
        return schema.node("code_block", { ...nesting, language: null }, [t(`code ${word}`)]);
      case "rule":
        return schema.node("horizontal_rule", nesting);
      case "level":
        return schema.node("paragraph", { ...nesting, level: 2 }, [t(word)]);
      case "empty":
        return schema.node("paragraph", nesting);
      default:
        return schema.node("paragraph", nesting, [t(word)]);
    }
  });
}

describe("nested blocks through Markdown", () => {
  it.each([
    ["markdown", markdownCodec({ schema })],
    ["mdx", mdxCodec({ schema, components })],
  ])("write, parse and write again gives the same text (%s)", (_name, codec) => {
    const random = rng(7);
    for (let n = 0; n < 1000; n++) {
      const blocks = randomBlocks(random);
      const written = (nodes: typeof blocks) => codec.serialize(nodes, UNSCOPED_DOCUMENT_LINKS);
      const first = written(codec.parse(written(blocks)).blocks);
      const second = written(codec.parse(first).blocks);
      expect(second, JSON.stringify(blocks.map((b) => [b.type.name, b.attrs]))).toBe(first);
    }
  });
});
