import type { MarkCodec } from "../../types.js";

export const strongMarkCodec: MarkCodec<{ type: string }> = {
  name: "strong",

  serialize(text) {
    return `**${text}**`;
  },

  parse(ast) {
    return ast.type === "strong" ? {} : null;
  },
};
