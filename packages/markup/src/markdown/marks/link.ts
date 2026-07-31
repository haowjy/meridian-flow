import type { MarkCodec } from "../../types.js";
import { wikilinkTarget } from "../wikilink-target.js";

type LinkAst = { type: string; url?: string; title?: string | null; target?: string };

export const linkMarkCodec: MarkCodec<LinkAst> = {
  name: "link",

  serialize(text, attrs) {
    const href = String(attrs.href ?? "");
    const wikiTarget = wikilinkTarget(href);
    if (wikiTarget !== null && markdownText(text) === wikiTarget && attrs.title == null)
      return `[[${wikiTarget}]]`;
    const title = attrs.title == null ? "" : ` "${String(attrs.title).replaceAll('"', '\\"')}"`;
    return `[${text.replaceAll("]", "\\]")}](${markdownLinkDestination(href)}${title})`;
  },

  parse(ast) {
    if (ast.type === "wikiLink" && typeof ast.target === "string") {
      return { href: `[[${ast.target}]]`, title: null };
    }
    if (ast.type === "wikiLinkResource" && typeof ast.target === "string") {
      return { href: `[[${ast.target}]]`, title: ast.title ?? null };
    }
    if (ast.type !== "link") return null;
    return { href: ast.url ?? "", title: ast.title ?? null };
  },
};

function markdownText(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function markdownLinkDestination(href: string): string {
  if (!href.includes("\t")) return href;
  return `<${href.replace(/[\\<>]/g, "\\$&")}>`;
}
