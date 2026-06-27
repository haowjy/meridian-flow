import type { MarkCodec } from "../../types.js";

export const strikeMarkCodec: MarkCodec<{ type: string }> = {
  name: "strike",

  serialize(text) {
    return `~~${text}~~`;
  },

  parse(ast) {
    return ast.type === "delete" ? {} : null;
  },
};
