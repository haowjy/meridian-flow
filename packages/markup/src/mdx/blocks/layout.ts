/** Maps the reserved Layout wire wrapper to layout attrs on ordinary block nodes. */

import type { Node as PMNode } from "prosemirror-model";

import { builtInComponents } from "../../components.js";
import {
  invalidJsxFallback,
  isMdxJsxFlowElement,
  jsxAttribute,
  type MdastJsxFlow,
  parseComponentProps,
  parseRecognizedBlockAst,
  stringifyBlock,
} from "../../helpers.js";
import { getRuntime } from "../../runtime.js";
import type { BlockCodec, SerializeContext } from "../../types.js";

type LayoutAlign = "center" | "right";

export function createLayoutCodec(): BlockCodec<MdastJsxFlow> {
  return {
    // Layout is a wire-only wrapper, so this name is intentionally not a schema node.
    name: "layout",

    serialize() {
      throw new Error("Layout is serialized through the MDX block wrapper hook");
    },

    parse(ast, ctx) {
      if (!isMdxJsxFlowElement(ast) || ast.name !== "Layout") return null;
      if (ast.children.length !== 1) return invalidJsxFallback(ast, ctx);

      const parsed = parseComponentProps("Layout", ast.attributes, builtInComponents.Layout);
      if (!parsed.ok) return invalidJsxFallback(ast, ctx);
      const align = parseAlign(parsed.props.align);
      if (parsed.props.align !== undefined && align === null) return invalidJsxFallback(ast, ctx);

      const childAst = ast.children[0];
      if (isMdxJsxFlowElement(childAst) && childAst.name !== "table") {
        return invalidJsxFallback(ast, ctx);
      }
      const child = parseRecognizedBlockAst(childAst, ctx, new Set(["layout"]));
      if (!child || !isAlignable(child)) return invalidJsxFallback(ast, ctx);

      const widthsValue = parsed.props.widths;
      if (widthsValue !== undefined) {
        if (child.type.name !== "table" || typeof widthsValue !== "string") {
          return invalidJsxFallback(ast, ctx);
        }
        // Grid columns, not first-row cells: a spanning cell covers several.
        const widths = parseWidths(widthsValue, gridColumnCount(child));
        if (!widths || widths.every((width) => width === null)) {
          return invalidJsxFallback(ast, ctx);
        }
        return applyLayout(child, align, widths);
      }

      if (align === null) return invalidJsxFallback(ast, ctx);
      return applyLayout(child, align, null);
    },
  };
}

export function serializeLayoutBlock(
  node: PMNode,
  serialized: string,
  ctx: SerializeContext,
): string {
  if (!isAlignable(node)) return serialized;
  const align = parseAlign(node.attrs.align);
  if (node.attrs.align !== null && node.attrs.align !== undefined && align === null) {
    throw new Error(`pm->mdast: invalid Layout align value "${String(node.attrs.align)}"`);
  }
  const widths = node.type.name === "table" ? widthsFromFirstRow(node) : null;
  if (align === null && widths === null) return serialized;

  if (serialized.trimStart().startsWith("<table>")) {
    const renderedAttributes = [
      align === null ? null : `align="${align}"`,
      widths === null ? null : `widths="${widths}"`,
    ].filter((attribute): attribute is string => attribute !== null);
    const opening = renderedAttributes.length > 0 ? ` ${renderedAttributes.join(" ")}` : "";
    const indented = serialized
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return `<Layout${opening}>\n${indented}\n</Layout>`;
  }

  const children = getRuntime(ctx).parseMarkdown(serialized).children;
  if (children.length !== 1) {
    throw new Error(`Layout can only wrap one serialized block, got ${children.length}`);
  }
  const attributes = [];
  if (align !== null) attributes.push(jsxAttribute("align", align));
  if (widths !== null) attributes.push(jsxAttribute("widths", widths));
  return stringifyBlock(ctx, {
    type: "mdxJsxFlowElement",
    name: "Layout",
    attributes,
    children,
  });
}

function isAlignable(node: PMNode): boolean {
  return (
    node.type.name === "paragraph" || node.type.name === "heading" || node.type.name === "table"
  );
}

function parseAlign(value: unknown): LayoutAlign | null {
  return value === "center" || value === "right" ? value : null;
}

function parseWidths(value: string, columnCount: number): Array<number | null> | null {
  const slots = value.split(",");
  if (slots.length !== columnCount) return null;
  const widths: Array<number | null> = [];
  for (const slot of slots) {
    if (slot === "") {
      widths.push(null);
      continue;
    }
    if (!/^\d+$/.test(slot)) return null;
    const width = Number(slot);
    if (!Number.isSafeInteger(width) || width <= 0) return null;
    widths.push(width);
  }
  return widths;
}

/** A cell's colspan, defaulting the way the schema does. */
function colspanOf(cell: PMNode): number {
  const value = cell.attrs.colspan;
  return typeof value === "number" && value > 0 ? value : 1;
}

function rowspanOf(cell: PMNode): number {
  const value = cell.attrs.rowspan;
  return typeof value === "number" && value > 0 ? value : 1;
}

/**
 * Walk the table's cells with the GRID column each one starts at.
 *
 * `widths` is a per-column list, and a cell's index among its row's children
 * stops being its column the moment anything spans: a colspan covers several
 * columns, and a rowspan from an earlier row pushes every cell after it along.
 * This is the smallest walk that keeps the wire's promise honest without
 * pulling prosemirror-tables into a package that only knows the model.
 */
function forEachCellWithColumn(
  table: PMNode,
  visit: (cell: PMNode, column: number, rowIndex: number, cellIndex: number) => void,
): number {
  // Rows still owed to a rowspan from above, per grid column.
  const heldBelow: number[] = [];
  let gridWidth = 0;

  table.forEach((row, _offset, rowIndex) => {
    let column = 0;
    row.forEach((cell, _cellOffset, cellIndex) => {
      while ((heldBelow[column] ?? 0) > 0) column += 1;
      visit(cell, column, rowIndex, cellIndex);
      const span = colspanOf(cell);
      const rows = rowspanOf(cell);
      for (let slot = column; slot < column + span; slot += 1) heldBelow[slot] = rows;
      column += span;
      gridWidth = Math.max(gridWidth, column);
    });
    for (let slot = 0; slot < heldBelow.length; slot += 1) {
      heldBelow[slot] = Math.max(0, (heldBelow[slot] ?? 0) - 1);
    }
  });

  return gridWidth;
}

function applyLayout(
  node: PMNode,
  align: LayoutAlign | null,
  widths: readonly (number | null)[] | null,
): PMNode {
  if (!widths) return node.type.create({ ...node.attrs, align }, node.content, node.marks);

  const columns = new Map<PMNode, number>();
  forEachCellWithColumn(node, (cell, column) => {
    columns.set(cell, column);
  });

  const rows: PMNode[] = [];
  node.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => {
      const column = columns.get(cell) ?? 0;
      // A spanning cell carries one slot per column it covers, zero where that
      // column has no width — prosemirror-tables' own spelling, and what the
      // table view reads when it sizes the colgroup.
      const slots = Array.from(
        { length: colspanOf(cell) },
        (_, offset) => widths[column + offset] ?? 0,
      );
      cells.push(
        cell.type.create(
          { ...cell.attrs, colwidth: slots.some((width) => width > 0) ? slots : null },
          cell.content,
          cell.marks,
        ),
      );
    });
    rows.push(row.type.create(row.attrs, cells, row.marks));
  });
  return node.type.create({ ...node.attrs, align }, rows, node.marks);
}

function gridColumnCount(table: PMNode): number {
  return forEachCellWithColumn(table, () => {});
}

function widthsFromFirstRow(table: PMNode): string | null {
  validateColwidths(table);
  const firstRow = table.firstChild;
  if (!firstRow) return null;

  const slots: Array<string> = Array.from({ length: gridColumnCount(table) }, () => "");
  let hasWidth = false;
  forEachCellWithColumn(table, (cell, column, rowIndex) => {
    if (rowIndex !== 0) return;
    const colwidth = cell.attrs.colwidth;
    if (!Array.isArray(colwidth)) return;
    for (let offset = 0; offset < colspanOf(cell); offset += 1) {
      const width = colwidth[offset];
      if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0) continue;
      slots[column + offset] = String(width);
      hasWidth = true;
    }
  });
  return hasWidth ? slots.join(",") : null;
}

/**
 * `colwidth` is one entry per column the cell covers, and zero means "this
 * column has no width" — the shape prosemirror-tables writes when a resize
 * touches one column of a spanning cell, and the shape the table view reads.
 */
function validateColwidths(table: PMNode): void {
  table.forEach((row) => {
    row.forEach((cell) => {
      const colwidth = cell.attrs.colwidth;
      if (colwidth === null || colwidth === undefined) return;
      if (
        !Array.isArray(colwidth) ||
        colwidth.length !== colspanOf(cell) ||
        colwidth.some(
          (width) => typeof width !== "number" || !Number.isSafeInteger(width) || width < 0,
        )
      ) {
        throw new Error(
          "pm->mdast: table cell colwidth must be null or one non-negative integer per spanned column",
        );
      }
    });
  });
}
