import {
  inlineContentToMdast,
  type MdastHeading,
  parseInlineChildren,
  stringifyBlock,
} from "../internal.js";
import type { BlockCodec } from "../types.js";

export const headingCodec: BlockCodec<MdastHeading> = {
  name: "heading",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "heading",
      depth: Number(node.attrs.level ?? 1),
      children: inlineContentToMdast(node, ctx),
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "heading") return null;
    return ctx.schema.node("heading", { level: ast.depth }, parseInlineChildren(ast.children, ctx));
  },
};
