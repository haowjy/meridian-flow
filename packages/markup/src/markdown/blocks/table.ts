import type { Node as PMNode } from "prosemirror-model";
import {
  inlineContentToMdast,
  type MdastInline,
  type MdastTable,
  type MdastTableCell,
  parseInlineChildren,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec, SerializeContext } from "../../types.js";
import { parseHtmlTable, serializeHtmlTable } from "./table-html.js";

type TableAlignment = MdastTable["align"][number];
const GFM_INGRESS_HARD_BREAK = "<br/>";

export function normalizeGfmTableHardBreaks(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let index = 0;
  let fence: { marker: string; length: number } | null = null;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      index++;
      continue;
    }

    const openingFence = line.match(/^[\t ]{0,3}(`{3,}|~{3,})/);
    if (openingFence?.[1]) {
      fence = { marker: openingFence[1][0] ?? "", length: openingFence[1].length };
      out.push(line);
      index++;
      continue;
    }

    const header = pipeRowAt(lines, index);
    const delimiter = header ? pipeRowAt(lines, header.end + 1) : null;
    if (!header || !delimiter || !isDelimiterRow(delimiter.value)) {
      out.push(line);
      index++;
      continue;
    }

    out.push(header.value, delimiter.value);
    index = delimiter.end + 1;
    while (index < lines.length) {
      const row = pipeRowAt(lines, index);
      if (!row || isDelimiterRow(row.value)) break;
      out.push(row.value);
      index = row.end + 1;
    }
  }

  return out.join("\n");
}

export function canonicalizeGfmTableHardBreaks(serialized: string): string {
  const lines = serialized.split("\n");
  return lines.flatMap((line, index) => canonicalTableLine(lines, index, line)).join("\n");
}

export const tableCodec: BlockCodec<MdastTable> = {
  name: "table",

  serialize(node, ctx) {
    if (!isGfmRepresentable(node)) return serializeHtmlTable(node, ctx);
    const align = alignmentFromFirstRow(node);
    const table: MdastTable = { type: "table", align, children: [] };
    const hardBreakMarker = uniqueHardBreakMarker(node);

    node.forEach((row) => {
      const cells: MdastTableCell[] = [];
      row.forEach((cell) => {
        cells.push({
          type: "tableCell",
          children: hardBreaksForGfm(cellInlineChildren(cell, ctx), hardBreakMarker),
        });
      });
      table.children.push({ type: "tableRow", children: cells });
    });

    return stringifyBlock(ctx, table).replaceAll(hardBreakMarker, "\\\n");
  },

  parse(ast, ctx) {
    if (ast.type !== "table") return parseHtmlTable(ast, ctx);
    if (ast.children.length === 0) return null;

    const align = ast.align ?? [];
    return ctx.schema.node(
      "table",
      null,
      ast.children.map((row, rowIndex) =>
        ctx.schema.node(
          "table_row",
          null,
          row.children.map((cell, colIndex) =>
            ctx.schema.node(
              rowIndex === 0 ? "table_header" : "table_cell",
              { alignment: align[colIndex] ?? null },
              [
                ctx.schema.node(
                  "paragraph",
                  null,
                  parseInlineChildren(hardBreaksFromGfm(cell.children), ctx),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  },
};

function isGfmRepresentable(table: PMNode): boolean {
  const firstRow = table.firstChild;
  if (!firstRow || firstRow.childCount === 0) return false;
  if (!firstRow.content.content.every((cell) => cell.type.name === "table_header")) return false;

  const columnCount = firstRow.childCount;
  const alignment = alignmentFromFirstRow(table);
  let representable = true;
  table.forEach((row) => {
    if (row.childCount !== columnCount) representable = false;
    row.forEach((cell) => {
      const expectedType = row === firstRow ? "table_header" : "table_cell";
      if (cell.type.name !== expectedType) representable = false;
      if (!validUnitSpan(cell.attrs.colspan) || !validUnitSpan(cell.attrs.rowspan)) {
        representable = false;
      }
      if (!validAlignment(cell.attrs.alignment)) representable = false;
      const paragraph = cell.firstChild;
      if (!paragraph || (paragraph.childCount > 0 && /[\r\n]/.test(paragraph.textContent))) {
        representable = false;
      }
    });
  });

  table.forEach((row) => {
    row.forEach((cell, _offset, columnIndex) => {
      if (tableAlignment(cell.attrs.alignment) !== alignment[columnIndex]) representable = false;
    });
  });
  return representable;
}

function validUnitSpan(value: unknown): boolean {
  return value === undefined || value === 1;
}

function alignmentFromFirstRow(node: PMNode): TableAlignment[] {
  const firstRow = node.firstChild;
  if (!firstRow) return [];

  const align: TableAlignment[] = [];
  firstRow.forEach((cell) => {
    align.push(tableAlignment(cell.attrs.alignment));
  });
  return align;
}

function cellInlineChildren(cell: PMNode, ctx: SerializeContext): MdastTableCell["children"] {
  const paragraph = cell.firstChild;
  if (!paragraph) return [];
  return inlineContentToMdast(paragraph, ctx);
}

function tableAlignment(value: unknown): TableAlignment {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function validAlignment(value: unknown): boolean {
  return value === null || value === undefined || tableAlignment(value) !== null;
}

function hardBreaksForGfm(
  children: MdastTableCell["children"],
  marker: string,
): MdastTableCell["children"] {
  return replaceHardBreaks(children, (node) =>
    node.type === "break" ? ({ type: "html", value: marker } as MdastInline) : node,
  );
}

function hardBreaksFromGfm(children: MdastTableCell["children"]): MdastTableCell["children"] {
  return replaceHardBreaks(children, (node) => {
    if (node.type === "html" && node.value === GFM_INGRESS_HARD_BREAK) return { type: "break" };
    if (node.type === "mdxJsxTextElement") {
      const jsx = node as {
        name: string | null;
        children: MdastInline[];
        attributes: Array<{ type: string; name?: string; value?: unknown }>;
      };
      if (jsx.name === "br" && jsx.children.length === 0 && jsx.attributes.length === 0) {
        return { type: "break" };
      }
    }
    return node;
  });
}

function uniqueHardBreakMarker(table: PMNode): string {
  const serialized = JSON.stringify(table.toJSON());
  let suffix = 0;
  while (true) {
    const marker = `\uFDD0${suffix}\uFDEF`;
    if (!serialized.includes(marker)) return marker;
    suffix++;
  }
}

function replaceHardBreaks(
  children: MdastTableCell["children"],
  replace: (node: MdastInline) => MdastInline,
): MdastTableCell["children"] {
  return children.map((child) => {
    const replaced = replace(child);
    if (!("children" in replaced) || !Array.isArray(replaced.children)) return replaced;
    return {
      ...replaced,
      children: replaceHardBreaks(replaced.children as MdastInline[], replace),
    } as MdastInline;
  });
}

function pipeRowAt(lines: readonly string[], start: number): { value: string; end: number } | null {
  const first = lines[start];
  const prefix = first === undefined ? null : tableLinePrefix(lines, start);
  if (first === undefined || prefix === null) return null;

  let value = first;
  let end = start;
  while (hasOddTrailingBackslash(value)) {
    const continuation = lines[end + 1];
    const continuedPrefix = continuationPrefix(prefix);
    if (continuation === undefined || !continuation.startsWith(continuedPrefix)) return null;
    value = `${value.slice(0, -1)}${GFM_INGRESS_HARD_BREAK}${continuation.slice(continuedPrefix.length)}`;
    end++;
  }
  return value.trimEnd().endsWith("|") ? { value, end } : null;
}

function hasOddTrailingBackslash(value: string): boolean {
  const match = value.match(/\\+$/);
  return match !== null && match[0].length % 2 === 1;
}

function isDelimiterRow(value: string): boolean {
  const cells = value
    .slice(value.indexOf("|"))
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function closesFence(line: string, fence: { marker: string; length: number }): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^[\\t ]{0,3}${marker}{${fence.length},}[\\t ]*$`).test(line);
}

function canonicalTableLine(lines: readonly string[], index: number, line: string): string[] {
  const structuralPrefix = tableLinePrefix(lines, index);
  if (structuralPrefix === null || !line.includes("<br")) return [line];

  const prefix = continuationPrefix(structuralPrefix);
  const out: string[] = [""];
  let codeFenceLength = 0;
  let offset = 0;

  while (offset < line.length) {
    if (line[offset] === "`") {
      let runLength = 1;
      while (line[offset + runLength] === "`") runLength++;
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      out[out.length - 1] += line.slice(offset, offset + runLength);
      offset += runLength;
      continue;
    }

    const hardBreak = line.slice(offset).match(/^<br\s*\/>/i)?.[0];
    if (codeFenceLength === 0 && hardBreak && line[offset - 1] !== "\\") {
      out[out.length - 1] += "\\";
      out.push(prefix);
      offset += hardBreak.length;
      continue;
    }

    out[out.length - 1] += line[offset];
    offset++;
  }

  return out;
}

function continuationPrefix(prefix: string): string {
  return prefix.replace(/(^|> )([-+*] |\d+[.)] )$/, (_match, container: string, marker: string) => {
    return `${container}${" ".repeat(marker.length)}`;
  });
}

function tableLinePrefix(lines: readonly string[], index: number): string | null {
  const line = lines[index];
  if (line === undefined) return null;
  const pipe = line.indexOf("|");
  if (pipe === -1) return null;
  const prefix = line.slice(0, pipe);
  const { remainder } = stripQuotePrefix(prefix);
  if (/^(?: {0,3}| {0,3}(?:[-+*] |\d+[.)] ))$/.test(remainder)) return prefix;
  if (/^ {4,}$/.test(remainder) && hasListContainer(lines, index, remainder.length)) {
    return prefix;
  }
  return null;
}

function hasListContainer(lines: readonly string[], index: number, tableIndent: number): boolean {
  const tableQuoteDepth = stripQuotePrefix(lines[index] ?? "").depth;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = stripQuotePrefix(lines[cursor] ?? "");
    if (candidate.remainder.trim().length === 0) continue;
    if (candidate.depth !== tableQuoteDepth) return false;

    const marker = candidate.remainder.match(/^( *)(?:[-+*] |\d+[.)] )/);
    if (marker) {
      const contentIndent = marker[0].length;
      if (contentIndent <= tableIndent) return true;
    }

    const indentation = candidate.remainder.match(/^ */)?.[0].length ?? 0;
    if (indentation < tableIndent) return false;
  }
  return false;
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
