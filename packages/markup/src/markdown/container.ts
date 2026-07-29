/** Structural recognition for Markdown block containers. */

export interface MarkdownFence {
  marker: string;
  length: number;
}

export function openingFenceAt(lines: readonly string[], index: number): MarkdownFence | null {
  const content = fenceLineContent(lines, index);
  const opening = content?.match(/^(`{3,}|~{3,})/);
  const run = opening?.[1];
  return run ? { marker: run[0] ?? "", length: run.length } : null;
}

export function closesFence(
  lines: readonly string[],
  index: number,
  fence: MarkdownFence,
): boolean {
  const content = fenceLineContent(lines, index);
  if (content === null) return false;
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^${marker}{${fence.length},}[\\t ]*$`).test(content);
}

export function stripIndentedQuotePrefix(
  lines: readonly string[],
  index: number,
  line: string,
): { depth: number; remainder: string } {
  let depth = 0;
  let remainder = line;
  while (true) {
    const quote = remainder.match(/^ {0,3}> ?/);
    if (quote) {
      depth++;
      remainder = remainder.slice(quote[0].length);
      continue;
    }

    const indentedQuote = remainder.match(/^( {4,})> ?/);
    if (!indentedQuote?.[1] || !hasListContainerAtIndent(lines, index, indentedQuote[1].length)) {
      return { depth, remainder };
    }
    depth++;
    remainder = remainder.slice(indentedQuote[0].length);
  }
}

export function hasListContainerAtIndent(
  lines: readonly string[],
  index: number,
  blockIndent: number,
): boolean {
  const blockQuoteDepth = stripQuotePrefix(lines[index] ?? "").depth;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = stripQuotePrefix(lines[cursor] ?? "");
    if (candidate.remainder.trim().length === 0) continue;
    if (candidate.depth !== blockQuoteDepth) return false;

    const marker = candidate.remainder.match(/^( *)(?:[-+*] |\d+[.)] )/);
    if (marker) {
      const contentIndent = marker[0].length;
      if (contentIndent <= blockIndent) return blockIndent - contentIndent <= 3;
    }

    const indentation = candidate.remainder.match(/^ */)?.[0].length ?? 0;
    if (indentation < blockIndent) return false;
  }
  return false;
}

function fenceLineContent(lines: readonly string[], index: number): string | null {
  const { remainder } = stripIndentedQuotePrefix(lines, index, lines[index] ?? "");
  const listMarker = remainder.match(/^ {0,3}(?:[-+*] |\d+[.)] )/);
  if (listMarker) return remainder.slice(listMarker[0].length).replace(/^ {0,3}/, "");

  const indentation = remainder.match(/^ */)?.[0].length ?? 0;
  if (indentation <= 3 || hasListContainerAtIndent(lines, index, indentation)) {
    return remainder.slice(indentation);
  }
  return null;
}

function stripQuotePrefix(line: string): { depth: number; remainder: string } {
  let depth = 0;
  let remainder = line;
  while (true) {
    const quote = remainder.match(/^ {0,3}> ?/);
    if (!quote) return { depth, remainder };
    depth++;
    remainder = remainder.slice(quote[0].length);
  }
}
