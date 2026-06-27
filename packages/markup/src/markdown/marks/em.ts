import type { MarkCodec } from "../../types.js";

export const emMarkCodec: MarkCodec<{ type: string }> = {
  name: "em",

  serialize(text) {
    return `*${text}*`;
  },

  parse(ast) {
    return ast.type === "emphasis" ? {} : null;
  },
};
