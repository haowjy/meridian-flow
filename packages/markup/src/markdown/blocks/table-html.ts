/** Canonical HTML spelling for every table, including block-capable cells. */

import type { Mark, Node as PMNode } from "prosemirror-model";

import { inlineContentToMdast, type MdastInline, rawTextForAst } from "../../helpers.js";
import { getRuntime } from "../../runtime.js";
import type { ParseContext, SerializeContext } from "../../types.js";
import {
  decodeHtml,
  decodeHtmlAttribute,
  elementChildren,
  escapeHtmlAttribute,
  escapeHtmlText,
  type HtmlElement,
  type HtmlNode,
  parseHtml,
} from "../html-tag.js";
import { imageNodeFromAttributes } from "./image.js";
import { imageHtmlTag, parseRawImageHtmlAttributes } from "./image-html.js";

const ALIGNMENTS = new Set(["left", "center", "right"]);
const DELEGATED_BLOCK_ATTRIBUTE = "data-meridian-block";
const BLOCK_ELEMENTS = new Set([
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "hr",
  "table",
]);

export function serializeHtmlTable(table: PMNode, ctx: SerializeContext): string {
  return serializeTableLines(table, ctx, "").join("\n");
}

export function parseHtmlTable(ast: unknown, ctx: ParseContext): PMNode | null {
  const astType =
    typeof ast === "object" && ast !== null ? (ast as { type?: unknown }).type : undefined;
  if (astType !== "html" && astType !== "mdxJsxFlowElement") return null;
  const source = htmlSource(ast, ctx);
  if (!/^<table(?:\s|>)/i.test(source)) return null;
  const root = parseHtml(source);
  return root?.name === "table" ? parseTableElement(root, ctx) : null;
}

function serializeTableLines(table: PMNode, ctx: SerializeContext, indent: string): string[] {
  const rows = [...table.content.content];
  const hasHeader = rows[0]?.content.content.every((cell) => cell.type.name === "table_header");
  const lines = [`${indent}<table>`];

  if (hasHeader && rows[0]) {
    lines.push(`${indent}  <thead>`);
    lines.push(...serializeRow(rows[0], ctx, `${indent}    `));
    lines.push(`${indent}  </thead>`);
  }

  const bodyRows = hasHeader ? rows.slice(1) : rows;
  if (bodyRows.length > 0) {
    lines.push(`${indent}  <tbody>`);
    for (const row of bodyRows) lines.push(...serializeRow(row, ctx, `${indent}    `));
    lines.push(`${indent}  </tbody>`);
  }

  lines.push(`${indent}</table>`);
  return lines;
}

function serializeRow(row: PMNode, ctx: SerializeContext, indent: string): string[] {
  const lines = [`${indent}<tr>`];
  row.forEach((cell) => {
    const tag = cell.type.name === "table_header" ? "th" : "td";
    const cellIndent = `${indent}  `;
    lines.push(`${cellIndent}<${tag}${serializeCellAttrs(cell)}>`);
    cell.forEach((block) => {
      lines.push(...serializeCellBlock(block, ctx, `${cellIndent}  `));
    });
    lines.push(`${cellIndent}</${tag}>`);
  });
  lines.push(`${indent}</tr>`);
  return lines;
}

function serializeCellBlock(block: PMNode, ctx: SerializeContext, indent: string): string[] {
  switch (block.type.name) {
    case "paragraph":
      return [
        `${indent}<p${serializeBlockAlignment(block)}>${inlineToHtml(
          inlineContentToMdast(block, ctx),
        )}</p>`,
      ];
    case "heading": {
      const level = Number(block.attrs.level);
      if (!Number.isInteger(level) || level < 1 || level > 6) {
        throw new Error(
          `pm->html: invalid table-cell heading level "${String(block.attrs.level)}"`,
        );
      }
      return [
        `${indent}<h${level}${serializeBlockAlignment(block)}>${inlineToHtml(
          inlineContentToMdast(block, ctx),
        )}</h${level}>`,
      ];
    }
    case "bullet_list":
      return serializeList(block, ctx, indent, "ul");
    case "ordered_list":
      return serializeList(block, ctx, indent, "ol");
    case "blockquote": {
      const lines = [`${indent}<blockquote>`];
      block.forEach((child) => {
        lines.push(...serializeCellBlock(child, ctx, `${indent}  `));
      });
      lines.push(`${indent}</blockquote>`);
      return lines;
    }
    case "code_block": {
      const language = block.attrs.language;
      if (language !== null && typeof language !== "string") {
        throw new Error("pm->html: table-cell code language must be a string or null");
      }
      const className =
        typeof language === "string" ? ` class="language-${escapeHtmlAttribute(language)}"` : "";
      return [`${indent}<pre><code${className}>${escapeHtmlText(block.textContent)}</code></pre>`];
    }
    case "horizontal_rule":
      return [`${indent}<hr />`];
    case "table":
      return serializeDelegatedCellBlock(block, ctx, indent);
    default:
      return serializeDelegatedCellBlock(block, ctx, indent);
  }
}

/**
 * Raw HTML does not re-enter the Markdown/MDX parser for its children. Carry
 * the ordinary top-level spelling in an HTML attribute so the same registered
 * block codec owns both directions, including block kinds added later.
 */
function serializeDelegatedCellBlock(
  block: PMNode,
  ctx: SerializeContext,
  indent: string,
): string[] {
  const source = getRuntime(ctx).serializeBlock(block, ctx).replace(/\n+$/, "");
  const lines = [`${indent}<div ${DELEGATED_BLOCK_ATTRIBUTE}="${encodeURIComponent(source)}">`];

  if (block.type.name === "table") {
    lines.push(...source.split("\n").map((line) => `${indent}  ${line}`));
  } else {
    lines.push(`${indent}  <pre><code>${escapeHtmlText(source)}</code></pre>`);
  }

  lines.push(`${indent}</div>`);
  return lines;
}

function serializeList(
  list: PMNode,
  ctx: SerializeContext,
  indent: string,
  tag: "ul" | "ol",
): string[] {
  const tight = list.attrs.tight;
  if (typeof tight !== "boolean") {
    throw new Error("pm->html: table-cell list tight must be a boolean");
  }
  const attrs = [`data-tight="${String(tight)}"`];
  if (tag === "ol") {
    const order = list.attrs.order;
    if (!Number.isSafeInteger(order) || order < 1) {
      throw new Error("pm->html: table-cell ordered-list order must be a positive integer");
    }
    if (order !== 1) attrs.unshift(`start="${order}"`);
  }

  const lines = [`${indent}<${tag} ${attrs.join(" ")}>`];
  list.forEach((item) => {
    const checked = item.attrs.checked;
    if (checked !== null && typeof checked !== "boolean") {
      throw new Error("pm->html: table-cell list-item checked must be a boolean or null");
    }
    const checkedAttr = typeof checked === "boolean" ? ` data-checked="${String(checked)}"` : "";
    lines.push(`${indent}  <li${checkedAttr}>`);
    item.forEach((child) => {
      lines.push(...serializeCellBlock(child, ctx, `${indent}    `));
    });
    lines.push(`${indent}  </li>`);
  });
  lines.push(`${indent}</${tag}>`);
  return lines;
}

function serializeBlockAlignment(block: PMNode): string {
  const alignment = block.attrs.align;
  if (alignment === null || alignment === undefined) return "";
  if (alignment !== "center" && alignment !== "right") {
    throw new Error(`pm->html: invalid table-cell block alignment "${String(alignment)}"`);
  }
  return ` align="${alignment}"`;
}

function parseTableElement(table: HtmlElement, ctx: ParseContext): PMNode | null {
  if (table.attributes.size !== 0) return null;
  const rowElements = tableRows(table);
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
      const blocks = parseCellBlocks(cellElement, ctx);
      if (!attrs || !blocks) return null;
      cells.push(
        ctx.schema.node(cellElement.name === "th" ? "table_header" : "table_cell", attrs, blocks),
      );
    }
    rows.push(ctx.schema.node("table_row", null, cells));
  }

  return ctx.schema.node("table", null, rows);
}

function parseCellBlocks(cell: HtmlElement, ctx: ParseContext): PMNode[] | null {
  const hasBlock = cell.children.some(
    (child) => child.type === "element" && BLOCK_ELEMENTS.has(child.name),
  );
  if (!hasBlock) {
    const inline = parseInlineNodes(cell.children, ctx, []);
    return inline ? [ctx.schema.node("paragraph", null, inline)] : null;
  }

  const elements = elementChildren(cell);
  if (!elements) return null;
  const blocks: PMNode[] = [];
  for (const element of elements) {
    const block = parseCellBlock(element, ctx);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks.length > 0 ? blocks : null;
}

function parseCellBlock(element: HtmlElement, ctx: ParseContext): PMNode | null {
  if (element.name === "div") return parseDelegatedCellBlock(element, ctx);
  if (element.name === "p") {
    const align = blockAlignment(element);
    const inline = align === undefined ? null : parseInlineNodes(element.children, ctx, []);
    return inline ? ctx.schema.node("paragraph", { align }, inline) : null;
  }
  if (/^h[1-6]$/.test(element.name)) {
    const align = blockAlignment(element);
    const inline = align === undefined ? null : parseInlineNodes(element.children, ctx, []);
    return inline
      ? ctx.schema.node("heading", { level: Number(element.name[1]), align }, inline)
      : null;
  }
  if (element.name === "ul" || element.name === "ol") return parseList(element, ctx);
  if (element.name === "blockquote") {
    if (element.attributes.size !== 0) return null;
    const children = parseBlockContainer(element, ctx);
    return children ? ctx.schema.node("blockquote", null, children) : null;
  }
  if (element.name === "pre") return parseCodeBlock(element, ctx);
  if (element.name === "hr") {
    return element.attributes.size === 0 && element.children.length === 0
      ? ctx.schema.node("horizontal_rule")
      : null;
  }
  if (element.name === "table") return parseTableElement(element, ctx);
  return null;
}

function parseDelegatedCellBlock(element: HtmlElement, ctx: ParseContext): PMNode | null {
  if (element.attributes.size !== 1 || !element.attributes.has(DELEGATED_BLOCK_ATTRIBUTE)) {
    return null;
  }
  const encoded = element.attributes.get(DELEGATED_BLOCK_ATTRIBUTE);
  if (typeof encoded !== "string") return null;
  let source: string;
  try {
    source = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const blocks = getRuntime(ctx).parseBlocks(source, ctx);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  return block?.isBlock ? block : null;
}

function parseBlockContainer(element: HtmlElement, ctx: ParseContext): PMNode[] | null {
  const hasBlock = element.children.some(
    (child) => child.type === "element" && BLOCK_ELEMENTS.has(child.name),
  );
  if (!hasBlock) {
    const inline = parseInlineNodes(element.children, ctx, []);
    return inline ? [ctx.schema.node("paragraph", null, inline)] : null;
  }
  const elements = elementChildren(element);
  if (!elements) return null;
  const blocks = elements.map((child) => parseCellBlock(child, ctx));
  return blocks.every((block): block is PMNode => block !== null) ? blocks : null;
}

function parseList(element: HtmlElement, ctx: ParseContext): PMNode | null {
  const ordered = element.name === "ol";
  const allowed = new Set(ordered ? ["start", "data-tight"] : ["data-tight"]);
  if ([...element.attributes.keys()].some((name) => !allowed.has(name))) return null;
  const tight = booleanAttribute(element.attributes.get("data-tight"), false);
  if (tight === null) return null;

  let order = 1;
  if (ordered && element.attributes.has("start")) {
    const raw = element.attributes.get("start");
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    order = Number(raw);
    if (!Number.isSafeInteger(order) || order < 1) return null;
  }

  const itemElements = elementChildren(element);
  if (
    !itemElements ||
    itemElements.length === 0 ||
    itemElements.some((item) => item.name !== "li")
  ) {
    return null;
  }
  const items: PMNode[] = [];
  for (const itemElement of itemElements) {
    const checked = checkedAttribute(itemElement);
    const children = checked === undefined ? null : parseBlockContainer(itemElement, ctx);
    if (!children) return null;
    const content =
      children[0]?.type.name === "paragraph"
        ? children
        : [ctx.schema.node("paragraph"), ...children];
    items.push(ctx.schema.node("list_item", { checked }, content));
  }
  return ctx.schema.node(ordered ? "ordered_list" : "bullet_list", { order, tight }, items);
}

function checkedAttribute(element: HtmlElement): boolean | null | undefined {
  if ([...element.attributes.keys()].some((name) => name !== "data-checked")) return undefined;
  return booleanAttribute(element.attributes.get("data-checked"), null);
}

function booleanAttribute(
  value: string | null | undefined,
  fallback: boolean | null,
): boolean | null {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseCodeBlock(element: HtmlElement, ctx: ParseContext): PMNode | null {
  if (element.attributes.size !== 0) return null;
  const children = elementChildren(element);
  if (children?.length !== 1 || children[0]?.name !== "code") return null;
  const code = children[0];
  if (code.children.some((child) => child.type !== "text")) return null;
  const allowed = new Set(["class"]);
  if ([...code.attributes.keys()].some((name) => !allowed.has(name))) return null;
  const className = code.attributes.get("class");
  if (className === null) return null;
  const language =
    className === undefined
      ? null
      : decodeHtmlAttribute(className).startsWith("language-")
        ? decodeHtmlAttribute(className).slice("language-".length)
        : undefined;
  if (language === undefined) return null;
  const value = code.children
    .map((child) => (child.type === "text" ? decodeHtml(child.value) : ""))
    .join("");
  return ctx.schema.node(
    "code_block",
    { language },
    value.length > 0 ? [ctx.schema.text(value)] : [],
  );
}

function blockAlignment(element: HtmlElement): "center" | "right" | null | undefined {
  if ([...element.attributes.keys()].some((name) => name !== "align")) return undefined;
  const align = element.attributes.get("align");
  if (align === undefined) return null;
  return align === "center" || align === "right" ? align : undefined;
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
    case "text":
      return escapeHtmlText(inlineValue(node));
    case "strong":
      return `<strong>${inlineToHtml(inlineChildren(node))}</strong>`;
    case "emphasis":
      return `<em>${inlineToHtml(inlineChildren(node))}</em>`;
    case "delete":
      return `<del>${inlineToHtml(inlineChildren(node))}</del>`;
    case "inlineCode":
      return `<code>${escapeHtmlText(inlineValue(node))}</code>`;
    case "link": {
      const link = node as { url: string; title: string | null; children: MdastInline[] };
      const title = link.title === null ? "" : ` title="${escapeHtmlAttribute(link.title)}"`;
      return `<a href="${escapeHtmlAttribute(link.url)}"${title}>${inlineToHtml(link.children)}</a>`;
    }
    case "wikiLink": {
      const link = node as { target: string; children: MdastInline[] };
      return `<a href="${escapeHtmlAttribute(`[[${link.target}]]`)}">${inlineToHtml(
        link.children,
      )}</a>`;
    }
    case "wikiLinkResource": {
      const link = node as {
        target: string;
        title: string | null;
        children: MdastInline[];
      };
      const title = link.title === null ? "" : ` title="${escapeHtmlAttribute(link.title)}"`;
      return `<a href="${escapeHtmlAttribute(`[[${link.target}]]`)}"${title}>${inlineToHtml(
        link.children,
      )}</a>`;
    }
    case "break":
      return "<br />";
    case "image": {
      const image = node as { url: string; alt: string | null; title: string | null };
      return imageHtmlTag({ ...image, width: null });
    }
    case "wikiLinkImage": {
      const image = node as { target: string; alt: string | null; title: string | null };
      return imageHtmlTag({ ...image, url: `[[${image.target}]]`, width: null });
    }
    // Sized pictures have already escalated to their own HTML tag.
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

  return { alignment: alignment ?? null, colspan, rowspan, colwidth: null };
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
    href: decodeHtmlAttribute(href),
    title: title ? decodeHtmlAttribute(title) : null,
  });
}

function parseImage(element: HtmlElement, ctx: ParseContext): PMNode | null {
  const tag = parseRawImageHtmlAttributes(element.attributes);
  return tag ? imageNodeFromAttributes(ctx, tag) : null;
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
