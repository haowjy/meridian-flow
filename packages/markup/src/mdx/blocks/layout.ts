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
      if (isMdxJsxFlowElement(childAst)) return invalidJsxFallback(ast, ctx);
      const child = parseRecognizedBlockAst(childAst, ctx, new Set(["layout"]));
      if (!child || !isAlignable(child)) return invalidJsxFallback(ast, ctx);

      const widthsValue = parsed.props.widths;
      if (widthsValue !== undefined) {
        if (child.type.name !== "table" || typeof widthsValue !== "string") {
          return invalidJsxFallback(ast, ctx);
        }
        const widths = parseWidths(widthsValue, child.firstChild?.childCount ?? 0);
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

function applyLayout(
  node: PMNode,
  align: LayoutAlign | null,
  widths: readonly (number | null)[] | null,
): PMNode {
  if (!widths) return node.type.create({ ...node.attrs, align }, node.content, node.marks);
  const rows: PMNode[] = [];
  node.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell, _offset, columnIndex) => {
      const width = widths[columnIndex] ?? null;
      cells.push(
        cell.type.create(
          { ...cell.attrs, colwidth: width === null ? null : [width] },
          cell.content,
          cell.marks,
        ),
      );
    });
    rows.push(row.type.create(row.attrs, cells, row.marks));
  });
  return node.type.create({ ...node.attrs, align }, rows, node.marks);
}

function widthsFromFirstRow(table: PMNode): string | null {
  validateColwidths(table);
  const firstRow = table.firstChild;
  if (!firstRow) return null;
  const slots: string[] = [];
  let hasWidth = false;
  firstRow.forEach((cell) => {
    const value = Array.isArray(cell.attrs.colwidth) ? cell.attrs.colwidth[0] : null;
    const width =
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
    slots.push(width === null ? "" : String(width));
    hasWidth ||= width !== null;
  });
  return hasWidth ? slots.join(",") : null;
}

function validateColwidths(table: PMNode): void {
  table.forEach((row) => {
    row.forEach((cell) => {
      const colwidth = cell.attrs.colwidth;
      if (colwidth === null || colwidth === undefined) return;
      if (
        !Array.isArray(colwidth) ||
        colwidth.length !== 1 ||
        !Number.isSafeInteger(colwidth[0]) ||
        colwidth[0] <= 0
      ) {
        throw new Error("pm->mdast: table cell colwidth must be null or one positive integer");
      }
    });
  });
}
