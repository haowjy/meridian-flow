import type { MarkCodec } from "../types.js";

type LinkAst = { type: string; url?: string; title?: string | null };

export const linkMarkCodec: MarkCodec<LinkAst> = {
  name: "link",

  serialize(text, attrs) {
    const href = String(attrs.href ?? "");
    const title = attrs.title == null ? "" : ` "${String(attrs.title).replaceAll('"', '\\"')}"`;
    return `[${text.replaceAll("]", "\\]")}](${href}${title})`;
  },

  parse(ast) {
    if (ast.type !== "link") return null;
    return { href: ast.url ?? "", title: ast.title ?? null };
  },
};
