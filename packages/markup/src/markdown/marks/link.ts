import { inlineMarkdownToMdast } from "../../helpers.js";
import type { MarkCodec } from "../../types.js";
import { formatWikilink, wikilinkTarget } from "../wikilink-target.js";

type LinkAst = { type: string; url?: string; title?: string | null; target?: string };

export const linkMarkCodec: MarkCodec<LinkAst> = {
  name: "link",

  serialize(text, attrs, ctx) {
    const href = String(attrs.href ?? "");
    const wikiTarget = wikilinkTarget(href);
    if (wikiTarget !== null && attrs.title == null) {
      const children = inlineMarkdownToMdast(text, ctx);
      if (children.length === 1 && children[0]?.type === "text") {
        const label = (children[0] as { value: string }).value;
        if (!/[\r\n]/.test(label)) return formatWikilink(wikiTarget, label);
      }
    }
    const title = attrs.title == null ? "" : ` "${String(attrs.title).replaceAll('"', '\\"')}"`;
    return `[${text.replaceAll("]", "\\]")}](${markdownLinkDestination(href)}${title})`;
  },

  parse(ast) {
    if (ast.type === "wikiLink" && typeof ast.target === "string") {
      return { href: formatWikilink(ast.target), title: null };
    }
    if (ast.type === "wikiLinkResource" && typeof ast.target === "string") {
      return { href: formatWikilink(ast.target), title: ast.title ?? null };
    }
    if (ast.type !== "link") return null;
    return { href: ast.url ?? "", title: ast.title ?? null };
  },
};

function markdownLinkDestination(href: string): string {
  if (!href.includes("\t")) return href;
  return `<${href.replace(/[\\<>]/g, "\\$&")}>`;
}
