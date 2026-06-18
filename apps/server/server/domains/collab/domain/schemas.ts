import { type Node as PMNode, Schema } from "prosemirror-model";
import type { SchemaType } from "../ports/document-sync.js";
import {
  blockToMdx as blockToMdxSingle,
  docToMdx,
  documentMdxSchema,
  mdxToDoc,
} from "./mdx-bridge.js";

const documentSchema = documentMdxSchema();

const codeSchema = new Schema({
  nodes: {
    doc: { content: "code_block" },
    code_block: {
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
    },
    text: {},
  },
  marks: {},
});

export function getSchema(type: SchemaType): Schema {
  return type === "code" ? codeSchema : documentSchema;
}

export function mdxToNode(type: SchemaType, content: string): PMNode {
  if (type === "code") {
    const block = codeSchema.node(
      "code_block",
      { language: null },
      content.length > 0 ? [codeSchema.text(content)] : [],
    );
    return codeSchema.node("doc", null, [block]);
  }
  return mdxToDoc(content);
}

export function nodeToMdx(type: SchemaType, root: PMNode): string {
  if (type === "code") {
    return root.firstChild?.textContent ?? "";
  }
  return docToMdx(root);
}

export function blockToMdx(type: SchemaType, block: PMNode): string {
  if (type === "code") {
    return block.textContent;
  }
  return blockToMdxSingle(block);
}

export { docToMdx, mdxToDoc };
