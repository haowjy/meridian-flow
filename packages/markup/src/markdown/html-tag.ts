/**
 * The scrap of HTML the wire is allowed to carry, read and written in one place.
 *
 * Tables always use raw HTML, and a resized picture escalates to its own tag.
 * Both need the same three things: a tolerant reader for the tag soup a
 * document may already contain, an escaper strict enough for MDX, and one list
 * of which tags close themselves.
 *
 * The escaper's `{` and `}` are the MDX rule rather than an HTML one: an
 * unescaped brace opens a JSX expression, so a caption or a filename containing
 * one would take the rest of the document with it.
 */

import { parseEntities } from "parse-entities";

export type HtmlNode = HtmlElement | HtmlText;

export interface HtmlElement {
  type: "element";
  name: string;
  attributes: ReadonlyMap<string, string | null>;
  children: HtmlNode[];
}

export interface HtmlText {
  type: "text";
  value: string;
}

export const VOID_ELEMENTS = new Set(["br", "img"]);

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

export function decodeHtml(value: string): string {
  return parseEntities(value);
}

export function decodeHtmlAttribute(value: string): string {
  return parseEntities(value, { attribute: true });
}

/** The one element `source` holds, or null for anything else at all. */
export function parseHtml(source: string): HtmlElement | null {
  const root: HtmlElement = {
    type: "element",
    name: "#root",
    attributes: new Map(),
    children: [],
  };
  const stack = [root];
  let offset = 0;

  while (offset < source.length) {
    const tagStart = source.indexOf("<", offset);
    if (tagStart === -1) {
      stack.at(-1)?.children.push({ type: "text", value: source.slice(offset) });
      offset = source.length;
      break;
    }
    if (tagStart > offset) {
      stack.at(-1)?.children.push({ type: "text", value: source.slice(offset, tagStart) });
    }

    const parsed = parseTag(source, tagStart);
    if (!parsed) return null;
    offset = parsed.end;

    if (parsed.closing) {
      const current = stack.pop();
      if (!current || current === root || current.name !== parsed.name) return null;
      continue;
    }

    const element: HtmlElement = {
      type: "element",
      name: parsed.name,
      attributes: parsed.attributes,
      children: [],
    };
    stack.at(-1)?.children.push(element);
    if (!parsed.selfClosing && !VOID_ELEMENTS.has(parsed.name)) stack.push(element);
  }

  if (stack.length !== 1) return null;
  const children = elementChildren(root);
  return children?.length === 1 ? children[0] : null;
}

/**
 * `element`'s element children, or null when text the document can see stands
 * between them. Whitespace is layout and passes; anything else means the source
 * is not the shape the caller thought it was.
 */
export function elementChildren(element: HtmlElement): HtmlElement[] | null {
  const children: HtmlElement[] = [];
  for (const child of element.children) {
    if (child.type === "text") {
      if (decodeHtml(child.value).trim().length > 0) return null;
      continue;
    }
    children.push(child);
  }
  return children;
}

function parseTag(
  source: string,
  start: number,
): {
  name: string;
  attributes: Map<string, string | null>;
  closing: boolean;
  selfClosing: boolean;
  end: number;
} | null {
  let offset = start + 1;
  const closing = source[offset] === "/";
  if (closing) offset++;
  const nameStart = offset;
  while (/[A-Za-z0-9:-]/.test(source[offset] ?? "")) offset++;
  if (offset === nameStart) return null;
  const name = source.slice(nameStart, offset).toLowerCase();
  const attributes = new Map<string, string | null>();

  while (offset < source.length) {
    while (/\s/.test(source[offset] ?? "")) offset++;
    if (source[offset] === ">") {
      return { name, attributes, closing, selfClosing: false, end: offset + 1 };
    }
    if (source[offset] === "/" && source[offset + 1] === ">") {
      return { name, attributes, closing, selfClosing: true, end: offset + 2 };
    }
    if (closing) return null;

    const attrStart = offset;
    while (/[A-Za-z0-9:_-]/.test(source[offset] ?? "")) offset++;
    if (offset === attrStart) return null;
    const attrName = source.slice(attrStart, offset).toLowerCase();
    if (attributes.has(attrName)) return null;
    while (/\s/.test(source[offset] ?? "")) offset++;
    if (source[offset] !== "=") {
      attributes.set(attrName, null);
      continue;
    }

    offset++;
    while (/\s/.test(source[offset] ?? "")) offset++;
    const quote = source[offset];
    let value: string;
    if (quote === '"' || quote === "'") {
      offset++;
      const valueStart = offset;
      while (offset < source.length && source[offset] !== quote) offset++;
      if (offset >= source.length) return null;
      value = source.slice(valueStart, offset);
      offset++;
    } else {
      const valueStart = offset;
      while (offset < source.length && !/[\s>]/.test(source[offset] ?? "")) offset++;
      if (offset === valueStart) return null;
      value = source.slice(valueStart, offset);
    }
    attributes.set(attrName, value);
  }
  return null;
}
