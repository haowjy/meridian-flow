import type { Node as PMNode } from "prosemirror-model";
import {
  inlineContentToMdast,
  type MdastTable,
  type MdastTableCell,
  parseInlineChildren,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec, SerializeContext } from "../../types.js";

type TableAlignment = MdastTable["align"][number];

export const tableCodec: BlockCodec<MdastTable> = {
  name: "table",

  serialize(node, ctx) {
    const align = alignmentFromFirstRow(node);
    const table: MdastTable = { type: "table", align, children: [] };

    node.forEach((row) => {
      const cells: MdastTableCell[] = [];
      row.forEach((cell) => {
        cells.push({ type: "tableCell", children: cellInlineChildren(cell, ctx) });
      });
      table.children.push({ type: "tableRow", children: cells });
    });

    return stringifyBlock(ctx, table);
  },

  parse(ast, ctx) {
    if (ast.type !== "table") return null;
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
              [ctx.schema.node("paragraph", null, parseInlineChildren(cell.children, ctx))],
            ),
          ),
        ),
      ),
    );
  },
};

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
