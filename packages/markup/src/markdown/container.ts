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
    const quote = quotePrefixLength(remainder, 3);
    if (quote !== null) {
      depth++;
      remainder = remainder.slice(quote);
      continue;
    }

    const indentation = leadingWhitespace(remainder);
    if (
      indentation.columns < 4 ||
      remainder[indentation.offset] !== ">" ||
      !hasListContainerAtIndent(lines, index, indentation.columns)
    ) {
      return { depth, remainder };
    }
    depth++;
    remainder = remainder.slice(
      indentation.offset + 1 + optionalQuotePadding(remainder, indentation.offset + 1),
    );
  }
}

export function isContainerBlockPrefix(
  lines: readonly string[],
  index: number,
  prefix: string,
): boolean {
  const indentation = leadingWhitespace(prefix);
  if (indentation.offset === prefix.length) {
    return indentation.columns <= 3 || hasListContainerAtIndent(lines, index, indentation.columns);
  }

  const marker = listMarker(prefix);
  return marker !== null && marker.indentColumns <= 3 && marker.contentOffset === prefix.length;
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

    const marker = listMarker(candidate.remainder);
    if (marker && marker.contentColumn <= blockIndent) {
      return blockIndent - marker.contentColumn <= 3;
    }

    if (leadingWhitespace(candidate.remainder).columns < blockIndent) return false;
  }
  return false;
}

function fenceLineContent(lines: readonly string[], index: number): string | null {
  const { remainder } = stripIndentedQuotePrefix(lines, index, lines[index] ?? "");
  const marker = listMarker(remainder);
  if (marker && marker.indentColumns <= 3) return remainder.slice(marker.contentOffset);

  const indentation = leadingWhitespace(remainder);
  if (indentation.columns <= 3 || hasListContainerAtIndent(lines, index, indentation.columns)) {
    return remainder.slice(indentation.offset);
  }
  return null;
}

function stripQuotePrefix(line: string): { depth: number; remainder: string } {
  let depth = 0;
  let remainder = line;
  while (true) {
    const quote = quotePrefixLength(remainder, 3);
    if (quote === null) return { depth, remainder };
    depth++;
    remainder = remainder.slice(quote);
  }
}

function listMarker(line: string): {
  contentColumn: number;
  contentOffset: number;
  indentColumns: number;
} | null {
  const indentation = leadingWhitespace(line);
  const marker = line.slice(indentation.offset).match(/^(?:[-+*]|\d{1,9}[.)])/)?.[0];
  if (!marker) return null;

  const markerOffset = indentation.offset + marker.length;
  const markerColumn = indentation.columns + marker.length;
  const padding = whitespaceFrom(line, markerOffset, markerColumn);
  if (padding.offset === markerOffset) return null;

  const paddingColumns = padding.columns - markerColumn;
  if (paddingColumns <= 4) {
    return {
      contentColumn: padding.columns,
      contentOffset: padding.offset,
      indentColumns: indentation.columns,
    };
  }

  const firstPadding = whitespaceFrom(line, markerOffset, markerColumn, 1);
  return {
    contentColumn: markerColumn + 1,
    contentOffset: firstPadding.offset,
    indentColumns: indentation.columns,
  };
}

function quotePrefixLength(line: string, maxIndent: number): number | null {
  const indentation = leadingWhitespace(line);
  if (indentation.columns > maxIndent || line[indentation.offset] !== ">") return null;
  return indentation.offset + 1 + optionalQuotePadding(line, indentation.offset + 1);
}

function optionalQuotePadding(line: string, offset: number): number {
  return line[offset] === " " || line[offset] === "\t" ? 1 : 0;
}

function leadingWhitespace(line: string): { columns: number; offset: number } {
  return whitespaceFrom(line, 0, 0);
}

function whitespaceFrom(
  line: string,
  startOffset: number,
  startColumn: number,
  characterLimit = Number.POSITIVE_INFINITY,
): { columns: number; offset: number } {
  let columns = startColumn;
  let offset = startOffset;
  let consumed = 0;
  while (offset < line.length && consumed < characterLimit) {
    if (line[offset] === " ") {
      columns++;
    } else if (line[offset] === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    offset++;
    consumed++;
  }
  return { columns, offset };
}
