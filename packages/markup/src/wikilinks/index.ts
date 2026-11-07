/** Pure wiki-style Markdown findings over the codec's positioned, preprocessed Markdown source. */

import type { Processor } from "unified";
import { type Frontmatter, type SourceRange, splitFrontmatter } from "../frontmatter.js";
import { normalizeGfmTableHardBreaks } from "../markdown/table-ingress.js";
import { markdownParser } from "../markdown-parse.js";

export type {
  Frontmatter,
  FrontmatterSplit,
  SourceRange,
} from "../frontmatter.js";
export { splitFrontmatter } from "../frontmatter.js";

export type WikilinkFinding = SourceRange & {
  kind: "wikilink";
  embed: boolean;
  linkpath: string;
  heading: string | null;
  block: string | null;
  label: string | null;
  size: { width: number; height: number | null } | null;
};
export type WikilinkSyntaxFinding =
  | Frontmatter
  | WikilinkFinding
  | (SourceRange & { kind: "escape"; literal: "[[" })
  | (SourceRange & { kind: "comment"; syntax: "percent" | "html" })
  | (SourceRange & {
      kind: "markdownLink";
      url: string;
      image: boolean;
      /** The written destination, angle brackets included; absent for `[x]()`. */
      destination: SourceRange | null;
    });

export type WikilinkScanOptions = {
  /** Prose projections use their host's node/mark semantics, not Markdown block or code syntax. */
  context?: "markdown" | "prose";
};

export type WikilinkScan = {
  /** Offsets are UTF-16 indices into this source, not necessarily the input before preprocessing. */
  source: string;
  findings: WikilinkSyntaxFinding[];
};

type SyntaxNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SyntaxNode[];
  url?: string;
  data?: { destination?: SourceRange };
};

/**
 * Record each inline link/image destination's source span on its node. No default
 * handler claims the `resourceDestination` wrapper token, so this adds, never replaces.
 */
function destinationSpans(this: Processor): void {
  const data = this.data();
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    {
      enter: {
        resourceDestination(token) {
          const node = this.stack[this.stack.length - 1] as SyntaxNode | undefined;
          if (!node || (node.type !== "link" && node.type !== "image")) return;
          node.data = {
            ...node.data,
            destination: { from: token.start.offset, to: token.end.offset },
          };
        },
      },
    },
  ];
}

const parser = markdownParser([destinationSpans]);

function range(node: SyntaxNode): SourceRange | null {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from === undefined || to === undefined ? null : { from, to };
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function overlaps(span: SourceRange, ranges: readonly SourceRange[]): boolean {
  return ranges.some((other) => span.from < other.to && span.to > other.from);
}

function escaped(source: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && source[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

function mask(source: string, ranges: readonly SourceRange[]): string {
  let cursor = 0;
  let result = "";
  for (const span of [...ranges].sort((a, b) => a.from - b.from)) {
    if (span.from < cursor) continue;
    result += source.slice(cursor, span.from);
    // Non-whitespace placeholders preserve offsets without manufacturing indented code.
    result += source.slice(span.from, span.to).replace(/[^\r\n]/g, "x");
    cursor = span.to;
  }
  return result + source.slice(cursor);
}

type Comment = Extract<WikilinkSyntaxFinding, { kind: "comment" }>;

/** Earlier opaque comments take precedence over any Markdown syntax in their contents. */
function discoverComments(
  source: string,
  excluded: readonly SourceRange[],
  prose = false,
): Comment[] {
  const hidden = [...excluded];
  const comments: Comment[] = [];
  let code: SourceRange[] | null = null;
  for (const match of source.matchAll(/%%|<!--/g)) {
    const from = match.index;
    const opener = { from, to: from + match[0].length };
    if (escaped(source, from) || overlaps(opener, hidden)) continue;
    if (!code && !prose) {
      code = [];
      walk(parser.parse(mask(source, hidden)) as SyntaxNode, (node) => {
        const span = range(node);
        if (span && (node.type === "code" || node.type === "inlineCode")) code?.push(span);
      });
    }
    if (overlaps(opener, code ?? [])) continue;
    const syntax = match[0] === "%%" ? "percent" : "html";
    const delimiter = syntax === "percent" ? "%%" : "-->";
    const end = source.indexOf(delimiter, opener.to);
    const comment: Comment = {
      kind: "comment",
      syntax,
      from,
      to: end < 0 ? source.length : end + delimiter.length,
    };
    comments.push(comment);
    hidden.push(comment);
    // Fences/backticks in this comment must not govern the next opener.
    code = null;
  }
  return comments;
}

/** Reports syntax only: it never resolves targets, validates YAML, or rewrites prose. */
export function scanWikilinks(sourceText: string, options: WikilinkScanOptions = {}): WikilinkScan {
  // Split raw YAML first: table-looking properties must never enter the table preprocessor.
  const prose = options.context === "prose";
  let source = sourceText;
  if (!prose) {
    const rawFrontmatter = splitFrontmatter(sourceText).frontmatter;
    const protectedRanges: SourceRange[] = rawFrontmatter ? [rawFrontmatter] : [];
    protectedRanges.push(...discoverComments(sourceText, protectedRanges));
    let cursor = 0;
    source = "";
    for (const span of protectedRanges) {
      source += normalizeGfmTableHardBreaks(sourceText.slice(cursor, span.from));
      source += sourceText.slice(span.from, span.to);
      cursor = span.to;
    }
    source += normalizeGfmTableHardBreaks(sourceText.slice(cursor));
  }
  const frontmatter = prose ? null : splitFrontmatter(source).frontmatter;
  const findings: WikilinkSyntaxFinding[] = frontmatter ? [frontmatter] : [];
  const hidden: SourceRange[] = frontmatter ? [frontmatter] : [];
  const comments = discoverComments(source, hidden, prose);
  findings.push(...comments);
  hidden.push(...comments);

  // Comments may contain Markdown fences themselves. Mask them before the authoritative parse.
  const blocked = [...hidden];
  if (!prose)
    walk(parser.parse(mask(source, hidden)) as SyntaxNode, (node) => {
      const span = range(node);
      if (!span) return;
      if (["code", "inlineCode", "html", "link", "image", "definition"].includes(node.type))
        blocked.push(span);
      if (node.type === "link" || node.type === "image")
        findings.push({
          ...span,
          kind: "markdownLink",
          url: node.url ?? "",
          image: node.type === "image",
          destination: node.data?.destination ?? null,
        });
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
  return { source, findings: findings.sort((a, b) => a.from - b.from || b.to - a.to) };
}

export {
  type Located,
  locate,
  rankWikilinkMatches,
  storedName,
  type WikilinkTarget,
  wantedPath,
  wikilinkMatches,
} from "./project-ranking.js";
