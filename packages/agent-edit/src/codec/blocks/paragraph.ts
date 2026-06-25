import {
  EMPTY_PARAGRAPH_SENTINEL,
  inlineContentToMdast,
  isParagraph,
  isSentinelParagraph,
  isWhitespaceOnlyParagraph,
  type MdastParagraph,
  parseInlineChildren,
  stringifyBlock,
} from "../internal.js";
import type { BlockCodec } from "../types.js";

export const paragraphCodec: BlockCodec<MdastParagraph> = {
  name: "paragraph",

  serialize(node, ctx) {
    const paragraph: MdastParagraph = isWhitespaceOnlyParagraph(node)
      ? { type: "paragraph", children: [{ type: "text", value: EMPTY_PARAGRAPH_SENTINEL }] }
      : { type: "paragraph", children: inlineContentToMdast(node, ctx) };
    return stringifyBlock(ctx, paragraph);
  },

  parse(ast, ctx) {
    if (!isParagraph(ast)) return null;
    if (isSentinelParagraph(ast)) return ctx.schema.node("paragraph");
    return ctx.schema.node("paragraph", null, parseInlineChildren(ast.children, ctx));
  },
};
