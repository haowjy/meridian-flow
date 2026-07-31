/** MDX ingress escaping for prose that contains JSX-significant characters. */

import { fromMarkdown } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { closesFence, type MarkdownFence, openingFenceAt } from "./markdown/container.js";

const RAW_HTML_CANDIDATE = /<(?:!--|!\[CDATA\[|[!?]|\/?[A-Za-z][A-Za-z0-9-]*(?=[\t\n\f\r />]))/;
const MDX_SYNTAX_PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

export function escapeProseForMdxIngress(text: string): string {
  const protectedText = protectRawHtmlLiterals(text);
  const enclosedDestinations = findEnclosedDestinations(protectedText);
  const candidate = escapePreparedMdxIngress(protectedText, enclosedDestinations.starts);
  if (enclosedDestinations.starts.size === 0) return candidate;

  try {
    const parsed = MDX_SYNTAX_PARSER.parse(candidate);
    if (containsExpectedResources(parsed, enclosedDestinations.resources)) return candidate;
  } catch {
    // A destination that MDX cannot consume stays escaped rather than becoming
    // a JSX opener.
  }
  return escapePreparedMdxIngress(protectedText, new Set());
}

function escapePreparedMdxIngress(
  text: string,
  enclosedDestinationStarts: ReadonlySet<number>,
): string {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let sourceOffset = 0;
  for (const line of lines) {
    lineStarts.push(sourceOffset);
    sourceOffset += line.length + 1;
  }
  const out: string[] = [];
  let fence: MarkdownFence | null = null;
  let htmlTableEnd = -1;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (fence) {
      out.push(line);
      if (closesFence(lines, index, fence)) fence = null;
      continue;
    }

    if (index <= htmlTableEnd) {
      out.push(line);
      continue;
    }

    if (/^[\t ]*(?:(?:>[\t ]*)|(?:[-+*][\t ]+)|(?:\d+[.)][\t ]+))*<table(?:\s|>)/i.test(line)) {
      const end = matchingHtmlTableEnd(lines, index);
      if (end !== null) {
        htmlTableEnd = end;
        out.push(line);
        continue;
      }
    }

    const openingFence = openingFenceAt(lines, index);
    if (openingFence) {
      fence = openingFence;
      out.push(line);
      continue;
    }

    out.push(escapeProseSegment(line, lineStarts[index] ?? 0, enclosedDestinationStarts));
  }
  return out.join("\n");
}

function matchingHtmlTableEnd(lines: readonly string[], start: number): number | null {
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    const tags = lines[index]?.matchAll(/<\/?table(?:\s[^>]*)?>/gi) ?? [];
    for (const tag of tags) depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return index;
  }
  return null;
}

function protectRawHtmlLiterals(text: string): string {
  if (!RAW_HTML_CANDIDATE.test(text)) return text;
  const ranges: Array<{ start: number; end: number; value: string }> = [];
  // CommonMark owns raw-HTML recognition. Reimplementing its block and inline
  // contexts here would make MDX ingress another partial Markdown parser.
  visitMarkdownNodes(fromMarkdown(text), (node) => {
    if (
      node.type !== "html" ||
      typeof node.value !== "string" ||
      isPreservedMarkupSyntax(node.value)
    ) {
      return;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === "number" && typeof end === "number") {
      ranges.push({ start, end, value: node.value });
    }
  });

  let protectedText = text;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    const source = protectedText.slice(range.start, range.end);
    const encoded = encodeRawHtmlSource(source, range.value);
    if (encoded !== null) {
      protectedText =
        protectedText.slice(0, range.start) + encoded + protectedText.slice(range.end);
    }
  }
  return protectedText;
}

function visitMarkdownNodes(node: unknown, visit: (node: MarkdownNode) => void): void {
  const record = node as MarkdownNode;
  visit(record);
  for (const child of record.children ?? []) visitMarkdownNodes(child, visit);
}

function isPreservedMarkupSyntax(value: string): boolean {
  const trimmed = value.trimStart();
  return (
    /^<table(?:\s|>)/i.test(trimmed) || trimmed === "<br/>" || tryConsumeJsxTag(trimmed, 0) !== null
  );
}

/**
 * Which raw tag names survive MDX ingress unescaped.
 *
 * Every component the writer or a model can name is PascalCase, so the rule is
 * mostly "looks like a component". `img` is the one lowercase exception: it is
 * the escalated spelling of a picture that carries a display size
 * (`markdown/blocks/image-html.ts`), and MDX reads a lowercase name as an
 * intrinsic element, so the tag needs no protection beyond being left alone.
 * Encoding it instead turned every resized picture into literal text.
 */
function isPreservedTagName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) || name === "img";
}

function encodeRawHtmlSource(source: string, value: string): string | null {
  const sourceLines = splitLines(source);
  const valueLines = splitLines(value);
  if (sourceLines.length !== valueLines.length) return null;

  const encoded: string[] = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index];
    const valueLine = valueLines[index];
    if (!sourceLine || !valueLine) return null;
    // CommonMark can expand a list-continuation tab into spaces in html.value.
    // Match the non-whitespace suffix so the source's container prefix survives.
    const valueContent = valueLine.body.trimStart();
    if (!sourceLine.body.endsWith(valueContent)) return null;
    encoded.push(
      sourceLine.body.slice(0, sourceLine.body.length - valueContent.length) +
        encodeMarkdownPunctuation(valueContent) +
        sourceLine.ending,
    );
  }
  return encoded.join("");
}

function splitLines(value: string): Array<{ body: string; ending: string }> {
  const lines: Array<{ body: string; ending: string }> = [];
  let start = 0;
  for (const match of value.matchAll(/\r\n?|\n/g)) {
    const index = match.index;
    lines.push({ body: value.slice(start, index), ending: match[0] });
    start = index + match[0].length;
  }
  lines.push({ body: value.slice(start), ending: "" });
  return lines;
}

function encodeMarkdownPunctuation(value: string): string {
  // Character references reach mdast as literal punctuation without exposing
  // that punctuation to MDX or inline Markdown constructs.
  return value.replace(/[!-/:-@[-`{-~]/g, (character) => {
    return `&#x${character.charCodeAt(0).toString(16).toUpperCase()};`;
  });
}

interface MarkdownNode {
  type?: string;
  title?: unknown;
  url?: unknown;
  value?: unknown;
  children?: unknown[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

function skipBalanced(text: string, start: number, open: string, close: string): number | null {
  if (text[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function tryConsumeJsxTag(text: string, start: number): number | null {
  if (text[start] !== "<") return null;
  let i = start + 1;
  const closing = text[i] === "/";
  if (closing) i++;

  const nameStart = i;
  while (i < text.length && /[A-Za-z0-9]/.test(text[i] ?? "")) i++;
  const name = text.slice(nameStart, i);
  if (!isPreservedTagName(name)) return null;

  if (closing) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    return text[i] === ">" ? i + 1 - start : null;
  }

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (i >= text.length) return null;

    if (text[i] === "/") return text[i + 1] === ">" ? i + 2 - start : null;
    if (text[i] === ">") return i + 1 - start;

    if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
      continue;
    }

    const attrStart = i;
    while (i < text.length && /[A-Za-z0-9:_-]/.test(text[i] ?? "")) i++;
    if (i === attrStart) return null;

    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "=") continue;
    i++;
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < text.length && text[i] !== quote) i++;
      if (i >= text.length) return null;
      i++;
    } else if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
    } else {
      while (i < text.length && !/[\s/>]/.test(text[i] ?? "")) i++;
    }
  }
  return null;
}

function tryConsumeInlineCodeSpan(text: string, start: number): number | null {
  if (text[start] !== "`") return null;

  let openLen = 0;
  while (start + openLen < text.length && text[start + openLen] === "`") openLen++;

  let i = start + openLen;
  while (i < text.length) {
    if (text[i] === "`") {
      let closeLen = 0;
      while (i + closeLen < text.length && text[i + closeLen] === "`") closeLen++;
      if (closeLen === openLen) return i + openLen - start;
      i += closeLen;
      continue;
    }
    i++;
  }
  return null;
}

function tryConsumeWikilink(text: string, start: number): number | null {
  if (text[start] !== "[" || text[start + 1] !== "[") return null;
  const close = text.indexOf("]]", start + 2);
  if (close === -1) return null;
  const target = text.slice(start + 2, close);
  if (!target.trim() || target.includes("|") || target.includes("]")) return null;
  return close + 2 - start;
}

function escapeProseSegment(
  segment: string,
  segmentOffset: number,
  enclosedDestinationStarts: ReadonlySet<number>,
): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "\\" && i + 1 < segment.length) {
      out += segment[i] + segment[i + 1];
      i += 2;
      continue;
    }
    if (segment[i] === "`") {
      const len = tryConsumeInlineCodeSpan(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
    }
    if (segment[i] === "[") {
      const len = tryConsumeWikilink(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
    }
    if (segment[i] === "<") {
      if (enclosedDestinationStarts.has(segmentOffset + i)) {
        out += "<";
        i++;
        continue;
      }
      if (segment.startsWith("<br/>", i)) {
        out += "<br/>";
        i += "<br/>".length;
        continue;
      }
      const len = tryConsumeJsxTag(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
      out += "\\<";
      i++;
      continue;
    }
    if (segment[i] === "{") {
      out += "\\{";
      i++;
      continue;
    }
    out += segment[i];
    i++;
  }
  return out;
}

function findEnclosedDestinations(text: string): {
  starts: ReadonlySet<number>;
  resources: Array<{ type: "link" | "image"; url: string; title: string | null }>;
} {
  const starts = new Set<number>();
  const resources: Array<{ type: "link" | "image"; url: string; title: string | null }> = [];
  if (!text.includes("](<")) return { starts, resources };

  visitMarkdownNodes(fromMarkdown(text), (node) => {
    if (node.type !== "link" && node.type !== "image") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return;
    const resource = text.slice(start, end);
    const destinationStart = enclosedDestinationStart(resource, node.title);
    if (destinationStart === null || typeof node.url !== "string") return;
    starts.add(start + destinationStart);
    resources.push({
      type: node.type,
      url: node.url,
      title: typeof node.title === "string" ? node.title : null,
    });
  });
  return { starts, resources };
}

function containsExpectedResources(
  tree: unknown,
  expected: ReadonlyArray<{ type: "link" | "image"; url: string; title: string | null }>,
): boolean {
  const remaining = [...expected];
  visitMarkdownNodes(tree, (node) => {
    const match = remaining.findIndex(
      (resource) =>
        node.type === resource.type &&
        node.url === resource.url &&
        (node.title ?? null) === resource.title,
    );
    if (match !== -1) remaining.splice(match, 1);
  });
  return remaining.length === 0;
}

function enclosedDestinationStart(resource: string, title: unknown): number | null {
  if (!resource.endsWith(")")) return null;
  let cursor = skipMarkdownWhitespaceBackward(resource, resource.length - 1);

  if (typeof title === "string") {
    const close = resource[cursor - 1];
    const open = close === ")" ? "(" : close;
    if ((open !== '"' && open !== "'" && open !== "(") || close === undefined) return null;
    cursor--;
    while (cursor > 0) {
      cursor--;
      if (resource[cursor] === open && !isEscaped(resource, cursor)) break;
    }
    if (resource[cursor] !== open) return null;
    cursor = skipMarkdownWhitespaceBackward(resource, cursor);
  }

  const destinationEnd = cursor - 1;
  if (resource[destinationEnd] !== ">") return null;
  for (let index = destinationEnd - 1; index >= 2; index--) {
    if (resource[index] !== "<" || isEscaped(resource, index)) continue;
    return resource[index - 1] === "(" && resource[index - 2] === "]" ? index : null;
  }
  return null;
}

function skipMarkdownWhitespaceBackward(value: string, start: number): number {
  let index = start;
  while (index > 0 && /[\t\n\r ]/.test(value[index - 1] ?? "")) index--;
  return index;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}
