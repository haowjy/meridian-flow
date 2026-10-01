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

/**
 * A destination the parser reads back as written. Bare when it can be;
 * enclosed in `<…>` for whitespace, unbalanced parentheses, angle brackets, or
 * a backslash (a bare backslash before punctuation is an escape and would be
 * eaten). Neither form may span lines, so a line ending travels
 * percent-encoded, which the document href resolver decodes back.
 */
export function markdownLinkDestination(href: string): string {
  const value = href.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0) break;
  }
  if (!/[\s<>\\]/.test(value) && depth === 0) return value;
  return `<${value.replace(/[\\<>]/g, "\\$&")}>`;
}

/**
 * `[label](href)` for plain-text label and destination: what an app writes
 * where no ProseMirror document is serialized (a chat reference, a clipboard
 * fallback). Escapes only what could end the label or open a construct that
 * swallows its closing bracket.
 */
export function formatMarkdownLink(label: string, href: string): string {
  const text = label.replace(/[\r\n]+/g, " ").replace(/[\\[\]`*<]/g, "\\$&");
  return `[${text}](${markdownLinkDestination(href)})`;
}
