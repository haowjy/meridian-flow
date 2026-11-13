/** Canonical HTML spelling for every table, including block-capable cells. */

import { type NestedNode, nestNodes, nestTree } from "@meridian/prosemirror-schema";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { type FlatBlock, flattenSources, type Source, withNesting } from "../../flatten.js";
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
const DELEGATED_BLOCK_ELEMENT = "meridian-block";
const DELEGATED_BLOCK_KIND_ATTRIBUTE = "kind";
const DELEGATED_BLOCK_SOURCE_ATTRIBUTE = "source";
const NATIVE_CELL_BLOCK_KINDS = new Set([
  "paragraph",
  "blockquote",
  "code_block",
  "horizontal_rule",
]);
const NOT_NESTED: FlatBlock<null> = {
  value: null,
  path: null,
  marker: null,
  kind: null,
  start: null,
  loose: null,
};
const BLOCK_ELEMENTS = new Set([
  DELEGATED_BLOCK_ELEMENT,
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
  const root = parseHtml(source, { opaqueElements: new Set([DELEGATED_BLOCK_ELEMENT]) });
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
    lines.push(...serializeCellBlocks(cell, ctx, `${cellIndent}  `));
    lines.push(`${cellIndent}</${tag}>`);
  });
  lines.push(`${indent}</tr>`);
  return lines;
}

/** A cell's (or quote's) blocks, grouped back into `ul`, `ol` and `li` by where each sits. */
function serializeCellBlocks(parent: PMNode, ctx: SerializeContext, indent: string): string[] {
  const blocks: PMNode[] = [];
  parent.forEach((block) => {
    blocks.push(block);
  });
  const render = (nodes: readonly NestedNode[], at: string): string[] =>
    nodes.flatMap((node): string[] => {
      if (node.type === "block") return serializeCellBlock(blocks[node.index], ctx, at);
      if (node.type === "quote") {
        return [`${at}<blockquote>`, ...render(node.children, `${at}  `), `${at}</blockquote>`];
      }
      const tag = node.list.kind === "ordered" ? "ol" : "ul";
      const attrs = [`data-tight="${String(!node.list.loose)}"`];
      if (tag === "ol" && node.list.start !== 1) attrs.unshift(`start="${node.list.start}"`);
      return [
        `${at}<${tag} ${attrs.join(" ")}>`,
        ...node.items.flatMap((item) => {
          const checked =
            item.marker === "todo" || item.marker === "done"
              ? ` data-checked="${String(item.marker === "done")}"`
              : "";
          return [`${at}  <li${checked}>`, ...render(item.children, `${at}    `), `${at}  </li>`];
        }),
        `${at}</${tag}>`,
      ];
    });
  return render(nestTree(nestNodes(blocks)), indent);
}

function serializeCellBlock(block: PMNode, ctx: SerializeContext, indent: string): string[] {
  if (!NATIVE_CELL_BLOCK_KINDS.has(block.type.name)) {
    return serializeDelegatedCellBlock(block, ctx, indent);
  }

  switch (block.type.name) {
    case "paragraph": {
      const tag = block.attrs.level === null ? "p" : `h${block.attrs.level}`;
      return [
        `${indent}<${tag}${serializeBlockAlignment(block)}>${inlineToHtml(
          inlineContentToMdast(block, ctx),
        )}</${tag}>`,
      ];
    }
    case "blockquote":
      return [
        `${indent}<blockquote>`,
        ...serializeCellBlocks(block, ctx, `${indent}  `),
        `${indent}</blockquote>`,
      ];
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
    default:
      throw new Error(`pm->html: unsupported native table-cell block "${block.type.name}"`);
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
  const source = getRuntime(ctx)
    .serializeBlock(withNesting(block, NOT_NESTED), ctx)
    .replace(/\n+$/, "");
  const kind = escapeHtmlAttribute(block.type.name);
  if (block.type.name !== "table") {
    return [
      `${indent}<${DELEGATED_BLOCK_ELEMENT} ${DELEGATED_BLOCK_KIND_ATTRIBUTE}="${kind}" ${DELEGATED_BLOCK_SOURCE_ATTRIBUTE}="${escapeHtmlAttribute(source)}" />`,
    ];
  }
  return [
    `${indent}<${DELEGATED_BLOCK_ELEMENT} ${DELEGATED_BLOCK_KIND_ATTRIBUTE}="${kind}">`,
    source,
    `${indent}</${DELEGATED_BLOCK_ELEMENT}>`,
  ];
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
      const blocks = parseBlockContainer(cellElement, ctx);
      if (!attrs || !blocks) return null;
      cells.push(
        ctx.schema.node(cellElement.name === "th" ? "table_header" : "table_cell", attrs, blocks),
      );
    }
    rows.push(ctx.schema.node("table_row", null, cells));
  }

  return ctx.schema.node("table", null, rows);
}

function parseCellSource(element: HtmlElement, ctx: ParseContext): Source<PMNode> | null {
  if (element.name === "ul" || element.name === "ol") return parseList(element, ctx);
  const block = parseCellBlock(element, ctx);
  return block && { type: "leaf", value: block };
}

function parseCellBlock(element: HtmlElement, ctx: ParseContext): PMNode | null {
  if (element.name === DELEGATED_BLOCK_ELEMENT) return parseDelegatedCellBlock(element, ctx);
  if (element.name === "p" || /^h[1-6]$/.test(element.name)) {
    const align = blockAlignment(element);
    const inline = align === undefined ? null : parseInlineNodes(element.children, ctx, []);
    const level = element.name === "p" ? null : Number(element.name[1]);
    return inline ? ctx.schema.node("paragraph", { align, level }, inline) : null;
  }
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
  const encodedKind = element.attributes.get(DELEGATED_BLOCK_KIND_ATTRIBUTE);
  if (typeof encodedKind !== "string") return null;
  const kind = decodeHtmlAttribute(encodedKind);
  if (NATIVE_CELL_BLOCK_KINDS.has(kind)) return null;

  let source: string;
  if (element.attributes.size === 1 && element.rawContent !== undefined) {
    source = element.rawContent.replace(/^\n/, "").replace(/\n$/, "");
  } else if (
    element.attributes.size === 2 &&
    element.rawContent === undefined &&
    element.attributes.has(DELEGATED_BLOCK_SOURCE_ATTRIBUTE)
  ) {
    const encoded = element.attributes.get(DELEGATED_BLOCK_SOURCE_ATTRIBUTE);
    if (typeof encoded !== "string") return null;
    source = decodeHtmlAttribute(encoded);
  } else {
    return null;
  }
  const blocks = getRuntime(ctx).parseBlocks(source, ctx);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  return block?.isBlock && block.type.name === kind ? block : null;
}

/** The blocks of a cell, quote or item, with any lists inside flattened onto the blocks. */
function parseBlockContainer(element: HtmlElement, ctx: ParseContext): PMNode[] | null {
  const sources = parseContainerSources(element, ctx);
  return sources && flattenBlocks(sources, ctx);
}

function flattenBlocks(sources: Array<Source<PMNode>>, ctx: ParseContext): PMNode[] {
  return flattenSources(sources).map((block) =>
    withNesting(block.value ?? ctx.schema.node("paragraph"), block),
  );
}

function parseContainerSources(
  element: HtmlElement,
  ctx: ParseContext,
): Array<Source<PMNode>> | null {
  const hasBlock = element.children.some(
    (child) => child.type === "element" && BLOCK_ELEMENTS.has(child.name),
  );
  if (!hasBlock) {
    const inline = parseInlineNodes(element.children, ctx, []);
    return inline ? [{ type: "leaf", value: ctx.schema.node("paragraph", null, inline) }] : null;
  }
  const elements = elementChildren(element);
  if (!elements) return null;
  const sources = elements.map((child) => parseCellSource(child, ctx));
  return sources.every((source): source is Source<PMNode> => source !== null) ? sources : null;
}

function parseList(element: HtmlElement, ctx: ParseContext): Source<PMNode> | null {
  const ordered = element.name === "ol";
  const allowed = new Set(ordered ? ["start", "data-tight"] : ["data-tight"]);
  if ([...element.attributes.keys()].some((name) => !allowed.has(name))) return null;
  const tight = booleanAttribute(element.attributes.get("data-tight"), false);
  if (tight === null) return null;

  let start: number | null = null;
  if (ordered && element.attributes.has("start")) {
    const raw = element.attributes.get("start");
    if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
    start = Number(raw);
  }

  const itemElements = elementChildren(element);
  if (
    !itemElements ||
    itemElements.length === 0 ||
    itemElements.some((item) => item.name !== "li")
  ) {
    return null;
  }
  const items: Array<{ checked: boolean | null; children: Array<Source<PMNode>> }> = [];
  for (const itemElement of itemElements) {
    const checked = checkedAttribute(itemElement);
    const children = checked === undefined ? null : parseContainerSources(itemElement, ctx);
    if (checked === undefined || !children) return null;
    items.push({ checked, children });
  }
  return { type: "list", ordered, start, spread: !tight, items };
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
    case "break":
      return "<br />";
    case "image": {
      const image = node as { url: string; alt: string | null; title: string | null };
      return imageHtmlTag({ ...image, width: null });
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
    // A stored ref is never in the wire; parse is syntax only.
    ref: null,
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
