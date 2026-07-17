/** Sanitizes clipboard HTML down to the elements understood by the editor schema. */

import { normalizeLinkHref } from "./link-url";

const DANGEROUS_ELEMENTS = new Set(["script", "style", "iframe", "embed", "object", "form"]);

const ELEMENT_NAMES = new Map<string, string>([
  ["p", "p"],
  ["div", "p"],
  ["br", "br"],
  ["b", "strong"],
  ["strong", "strong"],
  ["i", "em"],
  ["em", "em"],
  ["a", "a"],
  ["h1", "h1"],
  ["h2", "h2"],
  ["h3", "h3"],
  ["h4", "h4"],
  ["h5", "h5"],
  ["h6", "h6"],
  ["ul", "ul"],
  ["ol", "ol"],
  ["li", "li"],
  ["blockquote", "blockquote"],
  ["pre", "pre"],
  ["code", "code"],
  ["table", "table"],
  ["thead", "thead"],
  ["tbody", "tbody"],
  ["tfoot", "tfoot"],
  ["tr", "tr"],
  ["th", "th"],
  ["td", "td"],
  ["hr", "hr"],
  ["img", "img"],
]);

const EXPLICIT_URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Returns inert, schema-only HTML for ProseMirror's clipboard parser.
 *
 * This uses a fresh output document and an attribute allowlist rather than
 * mutating the untrusted tree. That makes new browser-supported attributes
 * unsafe by default, including every `on*` handler and inline CSS.
 */
export function sanitizePastedHTML(html: string): string {
  const parser = new DOMParser();
  const source = parser.parseFromString(html, "text/html");
  const output = document.implementation.createHTMLDocument("");

  appendSanitizedChildren(source.body, output.body, output);
  return output.body.innerHTML;
}

function appendSanitizedChildren(source: Node, target: Node, output: Document): void {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(output.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (!(child instanceof Element)) continue;

    const sourceName = child.localName.toLowerCase();
    if (DANGEROUS_ELEMENTS.has(sourceName)) continue;

    const outputName = ELEMENT_NAMES.get(sourceName);
    if (!outputName) {
      appendSanitizedChildren(child, target, output);
      continue;
    }

    const clean = output.createElement(outputName);
    if (outputName === "a") copyLinkHref(child, clean);
    if (outputName === "img" && !copyImageAttributes(child, clean)) continue;

    appendSanitizedChildren(child, clean, output);
    target.appendChild(clean);
  }
}

function copyLinkHref(source: Element, target: Element): void {
  const rawHref = source.getAttribute("href");
  if (rawHref === null) return;
  const href = normalizeLinkHref(withoutAsciiControls(rawHref));
  if (href) target.setAttribute("href", href);
}

function copyImageAttributes(source: Element, target: Element): boolean {
  const rawSrc = source.getAttribute("src");
  if (rawSrc === null) return false;
  const src = rawSrc.trim();
  if (!isSafeImageSrc(src)) return false;

  target.setAttribute("src", src);
  for (const attribute of ["alt", "title"] as const) {
    const value = source.getAttribute(attribute);
    if (value !== null) target.setAttribute(attribute, value);
  }
  return true;
}

function isSafeImageSrc(src: string): boolean {
  if (!src || withoutAsciiControls(src) !== src) return false;
  if (/^data:/i.test(src)) return /^data:image\/[a-z\d.+-]+(?:;[^,]*)?,/i.test(src);
  if (src.startsWith("//")) return true;
  if (!EXPLICIT_URI_SCHEME.test(src)) return true;

  try {
    const url = new URL(src);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function withoutAsciiControls(value: string): string {
  let clean = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 31 && codePoint !== 127) clean += character;
  }
  return clean;
}
