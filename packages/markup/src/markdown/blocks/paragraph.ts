import {
  EMPTY_PARAGRAPH_SENTINEL,
  inlineContentToMdast,
  isParagraph,
  isSentinelParagraph,
  isWhitespaceOnlyParagraph,
  type MdastHeading,
  type MdastParagraph,
  parseInlineChildren,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec } from "../../types.js";

export const paragraphCodec: BlockCodec<MdastParagraph | MdastHeading> = {
  name: "paragraph",

  serialize(node, ctx) {
    if (node.attrs.level !== null) {
      return stringifyBlock(ctx, {
        type: "heading",
        depth: Number(node.attrs.level),
        children: inlineContentToMdast(node, ctx),
      });
    }
    const paragraph: MdastParagraph = isWhitespaceOnlyParagraph(node)
      ? { type: "paragraph", children: [{ type: "text", value: EMPTY_PARAGRAPH_SENTINEL }] }
      : { type: "paragraph", children: inlineContentToMdast(node, ctx) };
    return stringifyBlock(ctx, paragraph);
  },

  parse(ast, ctx) {
    if (ast.type === "heading") {
      return ctx.schema.node(
        "paragraph",
        { level: ast.depth },
        parseInlineChildren(ast.children, ctx),
      );
    }
    if (!isParagraph(ast)) return null;
    if (isSentinelParagraph(ast)) return ctx.schema.node("paragraph");
    return ctx.schema.node("paragraph", null, parseInlineChildren(ast.children, ctx));
  },
};
