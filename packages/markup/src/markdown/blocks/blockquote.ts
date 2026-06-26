import {
  type MdastBlockquote,
  parseBlockChildren,
  pmBlockChildrenToMdast,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec } from "../../types.js";

export const blockquoteCodec: BlockCodec<MdastBlockquote> = {
  name: "blockquote",

  serialize(node, ctx) {
    return stringifyBlock(ctx, { type: "blockquote", children: pmBlockChildrenToMdast(node, ctx) });
  },

  parse(ast, ctx) {
    if (ast.type !== "blockquote") return null;
    return ctx.schema.node("blockquote", null, parseBlockChildren(ast.children, ctx));
  },
};
