import { storedLinkRef } from "@meridian/contracts";
import type { MdastJsxFlow, MdastJsxText, MdxJsxAttribute } from "../../ast.js";
import type { PMNode, SerializeContext } from "../../types.js";
import { decodeHtmlAttribute, escapeHtmlAttribute, parseHtml } from "../html-tag.js";

export type ImageHtmlAttributes = {
  url: string;
  alt: string | null;
  title: string | null;
  width: number | null;
};

/**
 * The picture as the wire spells it: whatever the serialize scope spells for
 * the stored source (an `asset:` ref as the address this project knows it by
 * or an empty destination, a stored `ref` as its target's current path,
 * anything else as it stands): a picture never fails the document.
 *
 * Shared by the two places a picture is serialized — alone as a block, and
 * among the words of a paragraph — so both climb the same ladder.
 */
export function imageWireAttributes(node: PMNode, ctx: SerializeContext): ImageHtmlAttributes {
  return {
    url: spelledSource(node, ctx),
    alt: attrStringOrNull(node.attrs.alt),
    title: attrStringOrNull(node.attrs.title),
    width: imageWidth(node.attrs.width),
  };
}

export function spelledSource(node: PMNode, ctx: SerializeContext): string {
  return ctx.links.spellSource({
    src: String(node.attrs.src ?? ""),
    ref: storedLinkRef(node.attrs.ref),
  }).href;
}

function attrStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function imageWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Attribute order is fixed so one picture has exactly one spelling. */
export function imageHtmlTag(image: ImageHtmlAttributes): string {
  const attributes = [`src="${escapeHtmlAttribute(image.url)}"`];
  if (image.alt !== null) attributes.push(`alt="${escapeHtmlAttribute(image.alt)}"`);
  if (image.title !== null) attributes.push(`title="${escapeHtmlAttribute(image.title)}"`);
  if (image.width !== null) attributes.push(`width="${image.width}"`);
  return `<img ${attributes.join(" ")} />`;
}

/**
 * The picture an AST node spells as a tag, or null when it is not one.
 *
 * Null for an unrecognized attribute as much as for another element: a tag
 * carrying something this package cannot write back is better left as the text
 * it already is than silently reduced to the part we understood.
 */
export function parseImageHtmlAst(ast: unknown): ImageHtmlAttributes | null {
  const record = typeof ast === "object" && ast !== null ? (ast as Record<string, unknown>) : null;
  if (!record) return null;

  if (record.type === "mdxJsxTextElement" || record.type === "mdxJsxFlowElement") {
    const element = ast as MdastJsxText | MdastJsxFlow;
    if (element.name !== "img" || element.children.length > 0) return null;
    const attributes = jsxAttributeMap(element.attributes);
    return attributes && parseImageHtmlAttributes(attributes);
  }

  if (record.type !== "html" || typeof record.value !== "string") return null;
  const element = parseHtml(record.value.trim());
  if (element?.name !== "img" || element.children.length > 0) return null;
  return parseRawImageHtmlAttributes(element.attributes);
}

export function parseRawImageHtmlAttributes(
  attributes: ReadonlyMap<string, string | null>,
): ImageHtmlAttributes | null {
  return parseImageHtmlAttributes(
    new Map(
      [...attributes].map(([name, value]) => [
        name,
        typeof value === "string" ? decodeHtmlAttribute(value) : value,
      ]),
    ),
  );
}

function parseImageHtmlAttributes(
  attributes: ReadonlyMap<string, string | null>,
): ImageHtmlAttributes | null {
  const allowed = new Set(["src", "alt", "title", "width"]);
  if ([...attributes.keys()].some((name) => !allowed.has(name))) return null;

  const src = attributes.get("src");
  const alt = attributes.get("alt");
  const title = attributes.get("title");
  if (typeof src !== "string" || alt === null || title === null) return null;

  const width = parseWidth(attributes.get("width"));
  if (width === undefined) return null;

  return { url: src, alt: alt ?? null, title: title ?? null, width };
}

function parseWidth(value: string | null | undefined): number | null | undefined {
  if (value === undefined) return null;
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const width = Number(value);
  return Number.isSafeInteger(width) && width > 0 ? width : undefined;
}

/**
 * JSX attributes as the flat name/value map the HTML reader speaks, or null for
 * anything this package would not write back: an expression attribute
 * (`width={n}`) is JavaScript nobody here evaluates, a spread is the same, and a
 * repeated name is a tag nobody meant to write.
 */
function jsxAttributeMap(
  attributes: readonly MdxJsxAttribute[],
): ReadonlyMap<string, string | null> | null {
  const map = new Map<string, string | null>();
  for (const attribute of attributes) {
    if (attribute.type !== "mdxJsxAttribute" || typeof attribute.value === "object") return null;
    if (map.has(attribute.name)) return null;
    map.set(attribute.name, attribute.value);
  }
  return map;
}
