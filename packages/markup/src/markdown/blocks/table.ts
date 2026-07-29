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
const GFM_HARD_BREAK = "<br/>";

export function normalizeGfmTableHardBreaks(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = pipeRowAt(lines, index);
    const delimiter = header ? pipeRowAt(lines, header.end + 1) : null;
    if (!header || !delimiter || !isDelimiterRow(delimiter.value)) {
      out.push(lines[index] ?? "");
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

export const tableCodec: BlockCodec<MdastTable> = {
  name: "table",

  serialize(node, ctx) {
    if (!isGfmRepresentable(node)) return serializeHtmlTable(node, ctx);
    const align = alignmentFromFirstRow(node);
    const table: MdastTable = { type: "table", align, children: [] };

    node.forEach((row) => {
      const cells: MdastTableCell[] = [];
      row.forEach((cell) => {
        cells.push({
          type: "tableCell",
          children: hardBreaksForGfm(cellInlineChildren(cell, ctx)),
        });
      });
      table.children.push({ type: "tableRow", children: cells });
    });

    return stringifyBlock(ctx, table).replaceAll(GFM_HARD_BREAK, "\\\n");
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

function hardBreaksForGfm(children: MdastTableCell["children"]): MdastTableCell["children"] {
  return replaceHardBreaks(children, (node) =>
    node.type === "break" ? ({ type: "html", value: GFM_HARD_BREAK } as MdastInline) : node,
  );
}

function hardBreaksFromGfm(children: MdastTableCell["children"]): MdastTableCell["children"] {
  return replaceHardBreaks(children, (node) => {
    if (node.type === "html" && node.value === GFM_HARD_BREAK) return { type: "break" };
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
  if (first === undefined || !/^[\t ]*\|/.test(first)) return null;

  let value = first;
  let end = start;
  while (hasOddTrailingBackslash(value)) {
    const continuation = lines[end + 1];
    if (continuation === undefined) return null;
    value = `${value.slice(0, -1)}${GFM_HARD_BREAK}${continuation}`;
    end++;
  }
  return value.trimEnd().endsWith("|") ? { value, end } : null;
}

function hasOddTrailingBackslash(value: string): boolean {
  const match = value.match(/\\+$/);
  return match !== null && match[0].length % 2 === 1;
}

function isDelimiterRow(value: string): boolean {
  const cells = value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}
