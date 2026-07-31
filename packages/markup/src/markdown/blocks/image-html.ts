/**
 * The raw-HTML spelling a picture escalates into once it carries a display size.
 *
 * Markdown's `![alt](src)` has nowhere to put a width, so a resized picture
 * takes the same road a table with a `colspan` takes: an HTML tag, written and
 * read by this package, understood by every Markdown renderer downstream. The
 * escalation is one-way and reversible — a picture at its natural size never
 * spells itself this way, and one whose size the writer cleared goes back to
 * `![alt](src)` byte for byte.
 *
 * The tag has to be readable in both dialects, and the two parsers hand it over
 * differently: pure Markdown reports a raw `html` node holding the source text,
 * while MDX has already parsed it into a JSX element (`img` is a lowercase
 * intrinsic, so MDX accepts it as-is once `escape.ts` lets it through). Both
 * shapes arrive here and leave as the same handful of facts.
 */

import type { MdastJsxFlow, MdastJsxText, MdxJsxAttribute } from "../../ast.js";
import type { PMNode, SerializeContext } from "../../types.js";
import { decodeHtmlAttribute, escapeHtmlAttribute, parseHtml } from "../html-tag.js";

/** The picture's wire facts, whichever dialect spelled them. */
export type ImageHtmlAttributes = {
  url: string;
  alt: string | null;
  title: string | null;
  /** CSS pixels, or null for a picture that carries no size. */
  width: number | null;
};

/**
 * The picture as the wire spells it: the `asset:` ref resolved to the path this
 * project knows it by, and any other source left exactly as it stands.
 *
 * Shared by the two places a picture is serialized — alone as a block, and
 * among the words of a paragraph — so both climb the same ladder.
 */
export function imageWireAttributes(node: PMNode, ctx: SerializeContext): ImageHtmlAttributes {
  const src = String(node.attrs.src ?? "");
  const assetId = src.startsWith("asset:") ? src.slice("asset:".length) : null;
  return {
    url: assetId ? ctx.assetPathResolver.pathForAsset(assetId) : src,
    alt: attrStringOrNull(node.attrs.alt),
    title: attrStringOrNull(node.attrs.title),
    width: imageWidth(node.attrs.width),
  };
}

function attrStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A width the codec cannot write back is no width: the picture serializes plain. */
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

/**
 * Read an image from raw HTML attributes, decoding entity references at the
 * boundary before the image becomes document data.
 */
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

/** Read attributes whose parser has already decoded their values, as MDX does. */
function parseImageHtmlAttributes(
  attributes: ReadonlyMap<string, string | null>,
): ImageHtmlAttributes | null {
  const allowed = new Set(["src", "alt", "title", "width"]);
  if ([...attributes.keys()].some((name) => !allowed.has(name))) return null;

  const src = attributes.get("src");
  const alt = attributes.get("alt");
  const title = attributes.get("title");
  // A bare `alt` or `title` with no value says nothing about the picture, and
  // the round-trip would invent `alt=""` for it.
  if (typeof src !== "string" || alt === null || title === null) return null;

  const width = parseWidth(attributes.get("width"));
  if (width === undefined) return null;

  return { url: src, alt: alt ?? null, title: title ?? null, width };
}

/**
 * The width the tag claims: a number, null for a tag that claims none, and
 * `undefined` for one this package would not write back the same way — a
 * percentage, a fraction, a zero.
 */
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
