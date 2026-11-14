/** Sanitizes clipboard HTML down to the elements understood by the editor schema. */

import { flattenDom, NESTING_DATA_ATTRIBUTES } from "./extensions/nesting/nesting-clipboard";
import {
  classifyLinkTarget,
  clipboardLinkAddress,
  clipboardLinkProject,
  clipboardLinkRef,
  clipboardPictureRef,
  clipboardUploadRef,
  internalClipboardTarget,
  LINK_ADDRESS_ATTRIBUTE,
  LINK_PROJECT_ATTRIBUTE,
  LINK_REF_ATTRIBUTE,
  normalizeLinkHref,
} from "./links";

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
  ["figure", "figure"],
  ["figcaption", "figcaption"],
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

  // Lists become blocks that carry their nesting before anything is dropped: the depth,
  // numbering and task state live on the list elements and attributes this pass removes.
  flattenDom(source.body);
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

    const outputName = internalClipboardTarget(child.getAttribute("data-meridian-link"))
      ? "a"
      : declaresNormalWeight(child)
        ? undefined
        : ELEMENT_NAMES.get(sourceName);
    if (!outputName) {
      appendSanitizedChildren(child, target, output);
      continue;
    }

    const clean = output.createElement(outputName);
    if (outputName === "a") copyLinkHref(child, clean);
    if (outputName === "img" && !copyImageAttributes(child, clean)) continue;
    if (outputName === "figure") copyFigureAttributes(child, clean);
    copyNesting(child, clean);

    appendSanitizedChildren(child, clean, output);
    target.appendChild(clean);
  }
}

/**
 * A bold element whose own style says it is not bold. Google Docs wraps its whole clipboard in
 * `<b style="font-weight:normal">`, and reading that as bold makes every pasted word bold.
 */
function declaresNormalWeight(element: Element): boolean {
  if (element.localName !== "b" && element.localName !== "strong") return false;
  const weight = (element as HTMLElement).style?.fontWeight;
  return weight === "normal" || weight === "400";
}

/** Values `flattenDom` writes, and nothing else. */
const NESTING_VALUES: Record<string, RegExp> = {
  "data-path": /^-{1,64}$/,
  "data-kind": /^ordered$/,
  "data-marker": /^(item|todo|done)$/,
  "data-start": /^\d{1,9}$/,
};

function copyNesting(source: Element, target: Element): void {
  for (const name of NESTING_DATA_ATTRIBUTES) {
    const value = source.getAttribute(name);
    if (value !== null && NESTING_VALUES[name]?.test(value)) target.setAttribute(name, value);
  }
}

function copyLinkHref(source: Element, target: Element): void {
  const internal = internalClipboardTarget(source.getAttribute("data-meridian-link"));
  if (internal) {
    target.setAttribute("data-meridian-link", internal);
    copyRecordedTarget(source, target, clipboardLinkRef);
    return;
  }
  const rawHref = source.getAttribute("href");
  if (rawHref === null) return;
  const href = normalizeLinkHref(withoutAsciiControls(rawHref));
  if (href) target.setAttribute("href", href);
}

/**
 * What an internal link or picture named where it was copied: its address,
 * and its ref and project, each only in the shape the copy writes (a picture's
 * ref may be an upload's `asset:<id>`, recorded with no address when copied
 * before the catalog held it). The link transform after this decides whether
 * the ref is kept (same project) or the address is bound fresh. Returns the
 * address.
 */
function copyRecordedTarget(
  source: Element,
  target: Element,
  readRef: (value: string | null) => string | null,
): string | null {
  const address = clipboardLinkAddress(source.getAttribute(LINK_ADDRESS_ATTRIBUTE));
  if (address) target.setAttribute(LINK_ADDRESS_ATTRIBUTE, address);
  const ref = readRef(source.getAttribute(LINK_REF_ATTRIBUTE));
  const project = clipboardLinkProject(source.getAttribute(LINK_PROJECT_ATTRIBUTE));
  if (ref && project && (address || clipboardUploadRef(ref))) {
    target.setAttribute(LINK_REF_ATTRIBUTE, ref);
    target.setAttribute(LINK_PROJECT_ATTRIBUTE, project);
  }
  return address;
}

function copyImageAttributes(source: Element, target: Element): boolean {
  // A picture copied from a Meridian document names a document address,
  // which is its source here; nothing a browser would fetch on its own.
  const address = copyRecordedTarget(source, target, clipboardPictureRef);
  // An upload recorded with no address keeps no source here: the link
  // transform restores its `asset:` source in the same project or drops it.
  const recordedUpload = !address && target.hasAttribute(LINK_REF_ATTRIBUTE);
  if (!recordedUpload) {
    const rawSrc = source.getAttribute("src");
    if (!address && rawSrc === null) return false;
    const src = address ?? rawSrc?.trim() ?? "";
    if (!address && !isSafeImageSrc(src)) return false;
    target.setAttribute("src", src);
  }
  for (const attribute of ["alt", "title"] as const) {
    const value = source.getAttribute(attribute);
    if (value !== null) target.setAttribute(attribute, value);
  }
  return true;
}

/** A Meridian figure keeps its type and label; any other `<figure>` is just its contents. */
function copyFigureAttributes(source: Element, target: Element): void {
  if (source.getAttribute("data-type") !== "figure") return;
  target.setAttribute("data-type", "figure");
  const label = source.getAttribute("data-label");
  if (label) target.setAttribute("data-label", label);
}

function isSafeImageSrc(src: string): boolean {
  if (!src || withoutAsciiControls(src) !== src) return false;
  if (/^data:/i.test(src)) return /^data:image\/[a-z\d.+-]+(?:;[^,]*)?,/i.test(src);
  if (src.startsWith("//")) return true;
  if (!EXPLICIT_URI_SCHEME.test(src)) return true;
  // A document address with no Meridian metadata (`manuscript://art/map.png`)
  // is a source like its bare-path spelling: the image door assigns it fresh.
  if (classifyLinkTarget(src)?.kind === "scheme") return true;

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
