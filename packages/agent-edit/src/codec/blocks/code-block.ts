import { type MdastCode, stringifyBlock } from "../internal.js";
import type { BlockCodec } from "../types.js";

export const codeBlockCodec: BlockCodec<MdastCode> = {
  name: "code_block",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "code",
      lang: node.attrs.language ?? null,
      value: node.textContent,
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "code") return null;
    return ctx.schema.node(
      "code_block",
      { language: ast.lang ?? null },
      ast.value.length > 0 ? [ctx.schema.text(ast.value)] : [],
    );
  },
};
