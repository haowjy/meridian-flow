import { storedLinkRef } from "@meridian/contracts";
import type { MarkCodec } from "../../types.js";

type LinkAst = { type: string; url?: string; title?: string | null };

export const linkMarkCodec: MarkCodec<LinkAst> = {
  name: "link",

  serialize(text, attrs, ctx) {
    const { href } = ctx.links.spellLink({
      href: String(attrs.href ?? ""),
      ref: storedLinkRef(attrs.ref),
    });
    const title = attrs.title == null ? "" : ` "${String(attrs.title).replaceAll('"', '\\"')}"`;
    return `[${text.replaceAll("]", "\\]")}](${markdownLinkDestination(href)}${title})`;
  },

  parse(ast) {
    if (ast.type !== "link") return null;
    return { href: ast.url ?? "", title: ast.title ?? null, ref: null };
  },
};

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

export function formatMarkdownLink(label: string, href: string): string {
  const text = label.replace(/[\r\n]+/g, " ").replace(/[\\[\]`*<]/g, "\\$&");
  return `[${text}](${markdownLinkDestination(href)})`;
}
