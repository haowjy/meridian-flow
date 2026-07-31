/** Canonical raw-HTML spelling for tables that GFM pipes cannot carry. */

import type { Mark, Node as PMNode } from "prosemirror-model";

import { inlineContentToMdast, type MdastInline, rawTextForAst } from "../../helpers.js";
import { getRuntime } from "../../runtime.js";
import type { ParseContext, SerializeContext } from "../../types.js";
import {
  decodeHtml,
  elementChildren,
  escapeHtmlAttribute,
  escapeHtmlText,
  type HtmlElement,
  type HtmlNode,
  parseHtml,
} from "../html-tag.js";
import { imageHtmlTag, parseImageHtmlAttributes } from "./image-html.js";

const ALIGNMENTS = new Set(["left", "center", "right"]);

export function serializeHtmlTable(table: PMNode, ctx: SerializeContext): string {
  const rows = [...table.content.content];
  const hasHeader = rows[0]?.content.content.every((cell) => cell.type.name === "table_header");
  const lines = ["<table>"];

  if (hasHeader && rows[0]) {
    lines.push("  <thead>");
    lines.push(...serializeRow(rows[0], ctx, "    "));
    lines.push("  </thead>");
  }

  const bodyRows = hasHeader ? rows.slice(1) : rows;
  if (bodyRows.length > 0) {
    lines.push("  <tbody>");
    for (const row of bodyRows) lines.push(...serializeRow(row, ctx, "    "));
    lines.push("  </tbody>");
  }

  lines.push("</table>");
  return lines.join("\n");
}

export function parseHtmlTable(ast: unknown, ctx: ParseContext): PMNode | null {
  const astType =
    typeof ast === "object" && ast !== null ? (ast as { type?: unknown }).type : undefined;
  if (astType !== "html" && astType !== "mdxJsxFlowElement") return null;
  const source = htmlSource(ast, ctx);
  if (!/^<table(?:\s|>)/i.test(source)) return null;
  const root = parseHtml(source);
  if (root?.name !== "table" || root.attributes.size !== 0) return null;

  const rowElements = tableRows(root);
  if (!rowElements || rowElements.length === 0) return null;

  const rows: PMNode[] = [];
  for (const rowElement of rowElements) {
    const cellElements = elementChildren(rowElement);
    if (
      !cellElements ||
      cellElements.length === 0 ||
      cellElements.some((cell) => cell.name !== "th" && cell.name !== "td")
    ) {
      return null;
    }

    const cells: PMNode[] = [];
    for (const cellElement of cellElements) {
      const attrs = cellAttrs(cellElement);
      if (!attrs) return null;
      const inline = parseInlineNodes(cellElement.children, ctx, []);
      if (!inline) return null;
      cells.push(
        ctx.schema.node(cellElement.name === "th" ? "table_header" : "table_cell", attrs, [
          ctx.schema.node("paragraph", null, inline),
        ]),
      );
    }
    rows.push(ctx.schema.node("table_row", null, cells));
  }

  return ctx.schema.node("table", null, rows);
}

function serializeRow(row: PMNode, ctx: SerializeContext, indent: string): string[] {
  const lines = [`${indent}<tr>`];
  row.forEach((cell) => {
    const tag = cell.type.name === "table_header" ? "th" : "td";
    const attributes = serializeCellAttrs(cell);
    const paragraph = cell.firstChild;
    const content = paragraph ? inlineToHtml(inlineContentToMdast(paragraph, ctx)) : "";
    lines.push(`${indent}  <${tag}${attributes}>${content}</${tag}>`);
  });
  lines.push(`${indent}</tr>`);
  return lines;
}

function serializeCellAttrs(cell: PMNode): string {
  const colspan = positiveSpan(cell.attrs.colspan, "colspan");
  const rowspan = positiveSpan(cell.attrs.rowspan, "rowspan");
  const alignment = cell.attrs.alignment;
  if (alignment !== null && alignment !== undefined && !ALIGNMENTS.has(alignment)) {
    throw new Error(`pm->html: invalid table cell alignment "${String(alignment)}"`);
  }

  const attrs: string[] = [];
  if (colspan !== 1) attrs.push(`colspan="${colspan}"`);
  if (rowspan !== 1) attrs.push(`rowspan="${rowspan}"`);
  if (typeof alignment === "string") attrs.push(`align="${alignment}"`);
  return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

function positiveSpan(value: unknown, name: string): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`pm->html: table cell ${name} must be a positive integer`);
  }
  return value as number;
}

function inlineToHtml(children: readonly MdastInline[]): string {
  return children.map(inlineNodeToHtml).join("");
}

function inlineNodeToHtml(node: MdastInline): string {
  switch (node.type) {
    case "text": {
      const value = inlineValue(node);
      return escapeHtmlText(value);
    }
    case "strong":
      return `<strong>${inlineToHtml(inlineChildren(node))}</strong>`;
    case "emphasis":
      return `<em>${inlineToHtml(inlineChildren(node))}</em>`;
    case "delete":
      return `<del>${inlineToHtml(inlineChildren(node))}</del>`;
    case "inlineCode": {
      const value = inlineValue(node);
      return `<code>${escapeHtmlText(value)}</code>`;
    }
    case "link": {
      const link = node as {
        url: string;
        title: string | null;
        children: MdastInline[];
      };
      const title = link.title === null ? "" : ` title="${escapeHtmlAttribute(link.title)}"`;
      return `<a href="${escapeHtmlAttribute(link.url)}"${title}>${inlineToHtml(link.children)}</a>`;
    }
    case "break":
      return "<br />";
    case "image": {
      const image = node as { url: string; alt: string | null; title: string | null };
      return imageHtmlTag({ ...image, width: null });
    }
    // A picture that already escalated to its own tag (a display size) arrives
    // written, and an HTML cell is the one place raw tags need no escaping.
    case "html":
      return String((node as { value?: unknown }).value ?? "");
    default:
      throw new Error(`pm->html: unsupported table inline node "${node.type}"`);
  }
}

function inlineValue(node: MdastInline): string {
  const value = (node as { value?: unknown }).value;
  if (typeof value !== "string") throw new Error(`pm->html: ${node.type} has no text value`);
  return value;
}

function inlineChildren(node: MdastInline): MdastInline[] {
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) throw new Error(`pm->html: ${node.type} has no inline children`);
  return children as MdastInline[];
}

function tableRows(table: HtmlElement): HtmlElement[] | null {
  const rows: HtmlElement[] = [];
  const children = elementChildren(table);
  if (!children) return null;
  for (const child of children) {
    if (child.name === "tr") {
      rows.push(child);
      continue;
    }
    if (child.name !== "thead" && child.name !== "tbody" && child.name !== "tfoot") return null;
    const groupRows = elementChildren(child);
    if (!groupRows || groupRows.some((row) => row.name !== "tr")) return null;
    rows.push(...groupRows);
  }
  return rows;
}

function cellAttrs(element: HtmlElement): Record<string, unknown> | null {
  const allowed = new Set(["align", "colspan", "rowspan", "style"]);
  if ([...element.attributes.keys()].some((name) => !allowed.has(name))) return null;

  const colspan = parseSpanAttribute(element.attributes.get("colspan"));
  const rowspan = parseSpanAttribute(element.attributes.get("rowspan"));
  if (colspan === null || rowspan === null) return null;

  const directAlignment = element.attributes.get("align");
  const style = element.attributes.get("style");
  const styleAlignment = style === undefined ? undefined : alignmentFromStyle(style);
  if (style !== undefined && styleAlignment === null) return null;
  if (
    typeof directAlignment === "string" &&
    typeof styleAlignment === "string" &&
    directAlignment !== styleAlignment
  ) {
    return null;
  }
  const alignment = directAlignment ?? styleAlignment;
  if (alignment !== undefined && alignment !== null && !ALIGNMENTS.has(alignment)) return null;

  return {
    alignment: alignment ?? null,
    colspan,
    rowspan,
    colwidth: null,
  };
}

function parseSpanAttribute(value: string | null | undefined): number | null {
  if (value === undefined) return 1;
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function alignmentFromStyle(style: string | null): string | null {
  if (style === null) return null;
  const declarations = style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  if (declarations.length !== 1) return null;
  const match = declarations[0]?.match(/^text-align\s*:\s*(left|center|right)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function parseInlineNodes(
  nodes: readonly HtmlNode[],
  ctx: ParseContext,
  marks: readonly Mark[],
): PMNode[] | null {
  const out: PMNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const value = decodeHtml(node.value);
      if (value.length > 0) out.push(ctx.schema.text(value, marks));
      continue;
    }

    if (node.name === "br" && node.attributes.size === 0 && node.children.length === 0) {
      out.push(ctx.schema.node("hard_break"));
      continue;
    }

    if (node.name === "img" && node.children.length === 0) {
      const image = parseImage(node, ctx);
      if (!image) return null;
      out.push(image.mark(marks));
      continue;
    }

    const mark = inlineMark(node, ctx);
    if (!mark) return null;
    const children = parseInlineNodes(node.children, ctx, [...marks, mark]);
    if (!children) return null;
    out.push(...children);
  }
  return out;
}

function inlineMark(element: HtmlElement, ctx: ParseContext): Mark | null {
  if (element.name === "strong" || element.name === "b") {
    return element.attributes.size === 0 ? ctx.schema.marks.strong.create() : null;
  }
  if (element.name === "em" || element.name === "i") {
    return element.attributes.size === 0 ? ctx.schema.marks.em.create() : null;
  }
  if (element.name === "del" || element.name === "s") {
    return element.attributes.size === 0 ? ctx.schema.marks.strike.create() : null;
  }
  if (element.name === "code") {
    return element.attributes.size === 0 ? ctx.schema.marks.code.create() : null;
  }
  if (element.name !== "a") return null;

  const allowed = new Set(["href", "title"]);
  if ([...element.attributes.keys()].some((name) => !allowed.has(name))) return null;
  const href = element.attributes.get("href");
  if (typeof href !== "string") return null;
  const title = element.attributes.get("title");
  if (title === null) return null;
  return ctx.schema.marks.link.create({
    href: decodeHtml(href),
    title: title ? decodeHtml(title) : null,
  });
}

function parseImage(element: HtmlElement, ctx: ParseContext): PMNode | null {
  const tag = parseImageHtmlAttributes(element.attributes);
  if (!tag) return null;

  const imageCodec = getRuntime(ctx).blockMap.get("image");
  return (
    imageCodec?.parse(
      {
        type: "html",
        value: imageHtmlTag({
          ...tag,
          url: decodeHtml(tag.url),
          alt: tag.alt === null ? null : decodeHtml(tag.alt),
          title: tag.title === null ? null : decodeHtml(tag.title),
        }),
      },
      ctx,
    ) ?? null
  );
}

function htmlSource(ast: unknown, ctx: ParseContext): string {
  const record = typeof ast === "object" && ast !== null ? (ast as Record<string, unknown>) : null;
  const raw =
    record?.type === "html" && typeof record.value === "string"
      ? record.value
      : rawTextForAst(ast, ctx);
  return raw
    .split("\n")
    .map((line) => line.replace(/^[\t ]*(?:>[\t ]*)+/, ""))
    .join("\n")
    .trim();
}
