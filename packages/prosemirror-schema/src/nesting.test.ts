/** Property test for `nest`: it reads any attribute values, and what it reads is stable.
 *
 * Pins implementation decisions: none; it states the model's totality.
 */
import { describe, expect, it } from "vitest";
import { type BlockFacts, type NestedNode, type NestInput, nest, nestTree } from "./nesting.js";

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

const JUNK: unknown[] = [42, {}, [], "3", -1, 1.5, 1e12, true, "x", undefined, null, NaN];

function randomBlocks(random: () => number, junk: boolean): NestInput[] {
  const count = 1 + Math.floor(random() * 14);
  return Array.from({ length: count }, () => {
    let path = "";
    for (let d = Math.floor(random() * 5); d > 0; d--) {
      path += (random() < 0.15 ? "|" : "") + pick(random, [">", "-", "-", "-"]);
    }
    const attrs: Record<string, unknown> = {
      path: path || null,
      kind: random() < 0.4 ? "ordered" : null,
      marker: pick(random, [null, "item", "item", "todo", "done"]),
      start: pick(random, [null, null, 1, 3, 0, 999_999_998, 999_999_999, 1_000_000_000]),
      loose: random() < 0.2 ? true : null,
    };
    if (junk) {
      for (const key of Object.keys(attrs)) {
        if (random() < 0.3) attrs[key] = pick(random, JUNK);
      }
    }
    return { attrs, plainParagraph: random() < 0.8 };
  });
}

/** Writes a tree back as attributes: the inverse of `nestTree`. */
function flatten(tree: NestedNode[]): NestInput[] {
  const out: NestInput[] = [];
  // `|` goes before the step that starts a new container, on the container's first block.
  const markFresh = (at: number, depth: number) => {
    const attrs = out[at].attrs as Record<string, unknown>;
    const path = String(attrs.path);
    attrs.path = `${path.slice(0, depth)}|${path.slice(depth)}`;
  };
  const walk = (nodes: NestedNode[], path: string) => {
    let previous: NestedNode["type"] | null = null;
    for (const node of nodes) {
      const at = out.length;
      if (node.type === "block") {
        out.push({ attrs: { path: path || null }, plainParagraph: true });
      } else if (node.type === "quote") {
        walk(node.children, `${path}>`);
        if (previous === "quote") markFresh(at, path.length);
      } else {
        const step = `${path}-`;
        node.items.forEach((item, i) => {
          const start = out.length;
          walk(item.children, step);
          const itemAttrs = {
            marker: item.marker ?? "item",
            kind: node.list.kind === "ordered" ? "ordered" : null,
            start: i === 0 && node.list.start !== 1 ? node.list.start : null,
            loose: node.list.loose ? true : null,
          };
          // The marker speaks for the innermost list only, so an item whose first block is in a
          // deeper list gets an empty block to carry its own.
          const first = out[start];
          if (first && String(first.attrs.path).slice(step.length).includes("-")) {
            out.splice(start, 0, { attrs: { path: step, ...itemAttrs }, plainParagraph: true });
          } else if (first) {
            Object.assign(first.attrs, itemAttrs);
          } else {
            out.push({ attrs: { path: step, ...itemAttrs }, plainParagraph: true });
          }
        });
        if (previous === "list") markFresh(at, path.length);
      }
      previous = node.type;
    }
  };
  walk(tree, "");
  return out;
}

function indexes(tree: NestedNode[]): number[] {
  return tree.flatMap((node) =>
    node.type === "block"
      ? [node.index]
      : node.type === "quote"
        ? indexes(node.children)
        : node.items.flatMap((item) => indexes(item.children)),
  );
}

function shape(tree: NestedNode[]): unknown {
  return JSON.stringify(tree, (key, value) => (key === "index" ? undefined : value));
}

describe("nest", () => {
  it("never throws, and puts every block in the tree once, in order", () => {
    const random = rng(1);
    for (let n = 0; n < 20_000; n++) {
      const blocks = randomBlocks(random, n % 2 === 1);
      const facts: BlockFacts[] = nest(blocks);
      expect(facts.length).toBe(blocks.length);
      expect(indexes(nestTree(facts))).toEqual(blocks.map((_, i) => i));
    }
  });

  // A block that opens two lists at once has an item with no block of its own, which written
  // out gets an empty paragraph (`- - x`); from there on the reading is a fixed point.
  it("reads back to the same tree after the tree is written as attributes", () => {
    const random = rng(2);
    for (let n = 0; n < 20_000; n++) {
      const first = nestTree(nest(randomBlocks(random, n % 2 === 1)));
      const tree = nestTree(nest(flatten(first)));
      const again = nestTree(nest(flatten(tree)));
      expect(shape(again)).toBe(shape(tree));
    }
  });
});
