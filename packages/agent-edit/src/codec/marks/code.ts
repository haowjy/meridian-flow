import type { MarkCodec } from "../types.js";

export const codeMarkCodec: MarkCodec<{ type: string }> = {
  name: "code",

  serialize(text) {
    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(longestRun + 1);
    const needsPadding = text.startsWith("`") || text.endsWith("`");
    return needsPadding ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
  },

  parse(ast) {
    return ast.type === "inlineCode" ? {} : null;
  },
};
