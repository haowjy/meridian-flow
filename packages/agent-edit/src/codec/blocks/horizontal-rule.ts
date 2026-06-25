import { type MdastThematicBreak, stringifyBlock } from "../internal.js";
import type { BlockCodec } from "../types.js";

export const horizontalRuleCodec: BlockCodec<MdastThematicBreak> = {
  name: "horizontal_rule",

  serialize(_node, ctx) {
    return stringifyBlock(ctx, { type: "thematicBreak" });
  },

  parse(ast, ctx) {
    if (ast.type !== "thematicBreak") return null;
    return ctx.schema.node("horizontal_rule");
  },
};
