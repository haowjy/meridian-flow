/** MDX ingress escaping for prose that contains JSX-significant characters. */

import { fromMarkdown } from "mdast-util-from-markdown";

import { closesFence, type MarkdownFence, openingFenceAt } from "./markdown/container.js";

export function escapeProseForMdxIngress(text: string): string {
  const lines = protectRawHtmlLiterals(text).split("\n");
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
      const end = lines.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex >= index && /<\/table>\s*$/i.test(candidate ?? ""),
      );
      if (end >= index) {
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

    out.push(escapeProseSegment(line));
  }
  return out.join("\n");
}

function protectRawHtmlLiterals(text: string): string {
  if (!text.includes("<")) return text;
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

function encodeRawHtmlSource(source: string, value: string): string | null {
  const sourceLines = source.split("\n");
  const valueLines = value.split("\n");
  if (sourceLines.length !== valueLines.length) return null;

  const encoded: string[] = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const sourceLine = sourceLines[index] ?? "";
    const valueLine = valueLines[index] ?? "";
    if (!sourceLine.endsWith(valueLine)) return null;
    encoded.push(
      sourceLine.slice(0, sourceLine.length - valueLine.length) +
        encodeMarkdownPunctuation(valueLine),
    );
  }
  return encoded.join("\n");
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
  value?: unknown;
  children?: unknown[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

function isPascalCaseComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
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
  if (!/[A-Z]/.test(text[i] ?? "")) return null;
  while (i < text.length && /[A-Za-z0-9]/.test(text[i] ?? "")) i++;
  const name = text.slice(nameStart, i);
  if (!isPascalCaseComponentName(name)) return null;

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

function escapeProseSegment(segment: string): string {
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
