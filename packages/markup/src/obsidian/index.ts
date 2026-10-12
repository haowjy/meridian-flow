/** Pure Obsidian findings over the codec's positioned, preprocessed Markdown source. */

import { normalizeGfmTableHardBreaks } from "../markdown/table-ingress.js";
import { markdownParser } from "../markdown-parse.js";
import {
  type ObsidianFrontmatter,
  type ObsidianRange,
  splitObsidianFrontmatter,
} from "./frontmatter.js";

export type {
  ObsidianFrontmatter,
  ObsidianFrontmatterSplit,
  ObsidianRange,
} from "./frontmatter.js";
export { splitObsidianFrontmatter } from "./frontmatter.js";

export type ObsidianWikilink = ObsidianRange & {
  kind: "wikilink";
  embed: boolean;
  linkpath: string;
  heading: string | null;
  block: string | null;
  label: string | null;
  size: { width: number; height: number | null } | null;
};
export type ObsidianFinding =
  | ObsidianFrontmatter
  | ObsidianWikilink
  | (ObsidianRange & { kind: "escape"; literal: "[[" })
  | (ObsidianRange & { kind: "comment"; syntax: "obsidian" | "html" })
  | (ObsidianRange & { kind: "callout"; calloutType: string; fold: "+" | "-" | null })
  | (ObsidianRange & { kind: "highlight"; text: string })
  | (ObsidianRange & { kind: "tag"; tag: string })
  | (ObsidianRange & { kind: "footnoteReference" | "footnoteDefinition"; identifier: string })
  | (ObsidianRange & { kind: "markdownLink"; url: string; image: boolean });

export type ObsidianScanOptions = {
  /** Skip ingress for already-parsed editor text; findings must index the existing text node. */
  preprocessed?: boolean;
};

export type ObsidianScan = {
  /** Offsets are UTF-16 indices into this source, not necessarily the input before preprocessing. */
  source: string;
  findings: ObsidianFinding[];
};

type SyntaxNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SyntaxNode[];
  identifier?: string;
  url?: string;
};

const parser = markdownParser();

function range(node: SyntaxNode): ObsidianRange | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from === undefined || to === undefined ? null : { from, to };
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function overlaps(span: ObsidianRange, ranges: readonly ObsidianRange[]): boolean {
  return ranges.some((other) => span.from < other.to && span.to > other.from);
}

function escaped(source: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && source[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

function mask(source: string, ranges: readonly ObsidianRange[]): string {
  let cursor = 0;
  let result = "";
  for (const span of [...ranges].sort((a, b) => a.from - b.from)) {
    if (span.from < cursor) continue;
    result += source.slice(cursor, span.from);
    result += source.slice(span.from, span.to).replace(/[^\r\n]/g, " ");
    cursor = span.to;
  }
  return result + source.slice(cursor);
}

/** Reports syntax only: it never resolves targets, validates YAML, or rewrites prose. */
export function scanObsidian(sourceText: string, options: ObsidianScanOptions = {}): ObsidianScan {
  // Split raw YAML first: table-looking properties must never enter the table preprocessor.
  const rawFrontmatter = splitObsidianFrontmatter(sourceText).frontmatter;
  const prefix = rawFrontmatter ? sourceText.slice(0, rawFrontmatter.to) : "";
  const source = options.preprocessed
    ? sourceText
    : prefix + normalizeGfmTableHardBreaks(sourceText.slice(prefix.length));
  const frontmatter = splitObsidianFrontmatter(source).frontmatter;
  const findings: ObsidianFinding[] = frontmatter ? [frontmatter] : [];
  const hidden: ObsidianRange[] = frontmatter ? [frontmatter] : [];
  const code: ObsidianRange[] = [];
  walk(parser.parse(mask(source, hidden)) as SyntaxNode, (node) => {
    const span = range(node);
    if (span && (node.type === "code" || node.type === "inlineCode")) code.push(span);
  });
  for (const match of source.matchAll(/%%|<!--/g)) {
    const from = match.index;
    if (
      escaped(source, from) ||
      overlaps({ from, to: from + match[0].length }, [...hidden, ...code])
    )
      continue;
    const syntax: "obsidian" | "html" = match[0] === "%%" ? "obsidian" : "html";
    const delimiter = syntax === "obsidian" ? "%%" : "-->";
    const end = source.indexOf(delimiter, from + match[0].length);
    const to = end < 0 ? source.length : end + delimiter.length;
    const comment = { kind: "comment" as const, syntax, from, to };
    findings.push(comment);
    hidden.push(comment);
  }

  // Comments may contain Markdown fences themselves. Mask them before the authoritative parse.
  const blocked = [...hidden];
  const quotes: ObsidianRange[] = [];
  walk(parser.parse(mask(source, hidden)) as SyntaxNode, (node) => {
    const span = range(node);
    if (!span) return;
    if (["code", "inlineCode", "html", "link", "image", "definition"].includes(node.type))
      blocked.push(span);
    if (node.type === "blockquote") quotes.push(span);
    if (node.type === "link" || node.type === "image")
      findings.push({
        ...span,
        kind: "markdownLink",
        url: node.url ?? "",
        image: node.type === "image",
      });
    if (node.type === "footnoteDefinition") {
      findings.push({ ...span, kind: "footnoteDefinition", identifier: node.identifier ?? "" });
    }
  });

  const accept = (from: number, to: number) =>
    !escaped(source, from) && !overlaps({ from, to }, blocked);
  for (const match of source.matchAll(/\\\[\\?\[/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (accept(from, to)) {
      findings.push({ kind: "escape", from, to, literal: "[[" });
      blocked.push({ from, to });
    }
  }
  for (const match of source.matchAll(/!?\[\[([^[\]\r\n]+)\]\]/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (!accept(from, to)) continue;
    const inner = match[1] ?? "";
    const bar = inner.search(/\\?\|/);
    const destination = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label =
      bar < 0
        ? null
        : inner
            .slice(bar)
            .replace(/^\\?\|/, "")
            .trim();
    const hash = destination.indexOf("#");
    const linkpath = (hash < 0 ? destination : destination.slice(0, hash)).trim();
    const fragment = hash < 0 ? null : destination.slice(hash + 1).trim();
    if (!linkpath && !fragment) continue;
    const embed = match[0].startsWith("!");
    const dimensions = embed && label ? /^(\d+)(?:x(\d+))?$/.exec(label) : null;
    findings.push({
      kind: "wikilink",
      from,
      to,
      embed,
      linkpath,
      heading: fragment?.startsWith("^") ? null : fragment,
      block: fragment?.startsWith("^") ? fragment.slice(1) : null,
      label: dimensions ? null : label,
      size: dimensions
        ? { width: Number(dimensions[1]), height: dimensions[2] ? Number(dimensions[2]) : null }
        : null,
    });
    blocked.push({ from, to });
  }
  for (const match of source.matchAll(/^[ \t]*(?:>[ \t]*)+\[!([\w-]+)\]([+-])?/gm)) {
    const from = match.index + match[0].indexOf("[!");
    const to = match.index + match[0].length;
    if (accept(from, to) && quotes.some((quote) => from >= quote.from && to <= quote.to))
      findings.push({
        kind: "callout",
        from,
        to,
        calloutType: match[1] ?? "",
        fold: (match[2] as "+" | "-" | undefined) ?? null,
      });
  }
  for (const match of source.matchAll(/==([^=\r\n]+)==/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (accept(from, to)) findings.push({ kind: "highlight", from, to, text: match[1] ?? "" });
  }
  for (const match of source.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
    const from = match.index + (match[1]?.length ?? 0);
    const to = match.index + match[0].length;
    const tag = match[2] ?? "";
    if (accept(from, to) && /[\p{L}_/-]/u.test(tag)) findings.push({ kind: "tag", from, to, tag });
  }
  for (const match of source.matchAll(/\[\^([^\]\r\n]+)\]/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (source[to] !== ":" && accept(from, to))
      findings.push({ kind: "footnoteReference", from, to, identifier: match[1] ?? "" });
  }
  return { source, findings: findings.sort((a, b) => a.from - b.from || b.to - a.to) };
}

export {
  type Located,
  locate,
  rankWikilinkMatches,
  storedName,
  type WikilinkTarget,
  wantedPath,
} from "./project-ranking.js";
