import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { expect } from "vitest";

import type { ComponentRegistry, mdxCodec } from "./index.js";

export const schema = buildDocumentSchema();
export const components = {
  StatBlock: {
    name: "StatBlock",
    kind: "leaf",
    children: "none",
    props: {
      value: { type: "number", required: true },
      config: { type: "object" },
    },
  },
  Badge: {
    name: "Badge",
    kind: "leaf",
    children: "inline",
    props: {
      tone: { type: "string", required: true },
    },
  },
  Panel: {
    name: "Panel",
    kind: "container",
    children: "block",
    props: {
      title: { type: "string", required: true },
      meta: { type: "object" },
    },
  },
} satisfies ComponentRegistry;

export const t = (text: string, marks?: readonly ReturnType<typeof schema.marks.strong.create>[]) =>
  schema.text(text, marks);
export const m = (
  name: "strong" | "em" | "code" | "link" | "strike",
  attrs?: Record<string, unknown>,
) => schema.marks[name].create(attrs);
export const paragraph = (...children: PMNode[]) => schema.node("paragraph", null, children);
export const emptyParagraph = () => schema.node("paragraph");

export function docFrom(blocks: PMNode[]): PMNode {
  return schema.node("doc", null, blocks);
}

export function parsedDoc(codec: ReturnType<typeof mdxCodec>, input: string): PMNode {
  return docFrom(codec.parse(input).blocks);
}

export function blocksOf(doc: PMNode): PMNode[] {
  return [...doc.content.content];
}

export function firstParsedBlock(codec: ReturnType<typeof mdxCodec>, input: string): PMNode {
  const block = codec.parse(input).blocks[0];
  if (!block) throw new Error("expected one parsed block");
  return block;
}

export function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

export function expectStable(codec: ReturnType<typeof mdxCodec>, input: string): void {
  const first = codec.parse(input).blocks;
  const serialized = codec.serialize(first);
  const second = codec.parse(serialized).blocks;
  expect(docFrom(second).toJSON()).toEqual(docFrom(first).toJSON());
  expect(codec.serialize(second)).toBe(serialized);
}
