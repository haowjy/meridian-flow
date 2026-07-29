import type { MarkCodec } from "../../types.js";

type LinkAst = { type: string; url?: string; title?: string | null; target?: string };

export const linkMarkCodec: MarkCodec<LinkAst> = {
  name: "link",

  serialize(text, attrs) {
    const href = String(attrs.href ?? "");
    const wikiTarget = wikilinkTarget(href);
    if (wikiTarget !== null && text === wikiTarget && attrs.title == null)
      return `[[${wikiTarget}]]`;
    const title = attrs.title == null ? "" : ` "${String(attrs.title).replaceAll('"', '\\"')}"`;
    return `[${text.replaceAll("]", "\\]")}](${href}${title})`;
  },

  parse(ast) {
    if (ast.type === "wikiLink" && typeof ast.target === "string") {
      return { href: `[[${ast.target}]]`, title: null };
    }
    if (ast.type !== "link") return null;
    return { href: ast.url ?? "", title: ast.title ?? null };
  },
};

function wikilinkTarget(href: string): string | null {
  if (!href.startsWith("[[") || !href.endsWith("]]")) return null;
  const target = href.slice(2, -2);
  return target.length > 0 && !target.includes("|") ? target : null;
}
