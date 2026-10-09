import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { expect } from "vitest";

import {
  type ComponentRegistry,
  type DocumentLinkScope,
  type MarkupCodec,
  type mdxCodec,
  UNSCOPED_DOCUMENT_LINKS,
} from "./index.js";

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
  const serialized = codec.serialize(first, UNSCOPED_DOCUMENT_LINKS);
  const second = codec.parse(serialized).blocks;
  expect(docFrom(second).toJSON()).toEqual(docFrom(first).toJSON());
  expect(codec.serialize(second, UNSCOPED_DOCUMENT_LINKS)).toBe(serialized);
}

/**
 * A fixed id ↔ path table, for codec fixtures: a serialize scope that spells
 * known `asset:` refs as their paths, and the binding pass hosts run after
 * the (pure) parse, which claims known paths as `asset:` refs.
 */
export function createAssetFixture(entries: Iterable<readonly [string, string]>): {
  links: DocumentLinkScope;
  bind(blocks: readonly PMNode[]): PMNode[];
  /** The codec as a host runs it: parse, then bind. */
  withBinding(codec: MarkupCodec): MarkupCodec;
} {
  const pathById = new Map(entries);
  const idByPath = new Map(Array.from(pathById, ([id, path]) => [path, id]));
  const bindNode = (node: PMNode): PMNode => {
    if (node.type.name === "image" || node.type.name === "figure") {
      const id = idByPath.get(String(node.attrs.src ?? ""));
      return id
        ? node.type.create({ ...node.attrs, src: `asset:${id}` }, node.content, node.marks)
        : node;
    }
    if (node.isLeaf) return node;
    const children: PMNode[] = [];
    node.forEach((child) => {
      children.push(bindNode(child));
    });
    return node.copy(Fragment.fromArray(children));
  };
  const bind = (blocks: readonly PMNode[]) => blocks.map(bindNode);
  return {
    links: {
      spellLink: UNSCOPED_DOCUMENT_LINKS.spellLink,
      spellSource(attrs) {
        const path = attrs.src.startsWith("asset:")
          ? pathById.get(attrs.src.slice("asset:".length))
          : undefined;
        return path ? { href: path, address: null } : UNSCOPED_DOCUMENT_LINKS.spellSource(attrs);
      },
    },
    bind,
    withBinding: (codec) => ({
      ...codec,
      parse: (content) => ({ blocks: bind(codec.parse(content).blocks) }),
      parseWithSpans: (content) => {
        const parsed = codec.parseWithSpans(content);
        return { ...parsed, blocks: bind(parsed.blocks) };
      },
    }),
  };
}
