import { parseDocumentFilename } from "@meridian/contracts/protocol";
import { Fragment, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

import type { AnchorRange } from "../anchors";
import { pictureKeyOfNode } from "../links/link-resolution";
import { remotePictureSource } from "./remote-image";

export function isImageFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name);
}

export function acceptsInlineImage(doc: PMNode, pos: number): boolean {
  const imageType = doc.type.schema.nodes.image;
  if (!imageType || pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  return $pos.parent.canReplaceWith($pos.index(), $pos.index(), imageType);
}

export function imageFileFromClipboard(event: ClipboardEvent): File | null {
  const item = Array.from(event.clipboardData?.items ?? []).find(
    (candidate) => candidate.kind === "file" && candidate.type.startsWith("image/"),
  );
  return item?.getAsFile() ?? null;
}

export function imageAltFromFilename(filename: string): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return stem || filename || "Image";
}

export type PastedImageImport = {
  url: string;
  alt: string | null;
};

export function linkExternalPastedImages(
  slice: Slice,
  schema: Schema,
): { slice: Slice; imports: PastedImageImport[] } {
  const imports: PastedImageImport[] = [];
  const linkType = schema.marks.link ?? null;

  const mapNode = (node: PMNode): PMNode => {
    if (node.type.name === "image") {
      const src = String(node.attrs.src ?? "");
      // A picture naming a document address (with a ref, or ref-less and
      // resolved by its address) is the project's own, never a web import.
      if (!src || src.startsWith("asset:") || pictureKeyOfNode(node.attrs)) return node;
      // A web picture, from any source, lands as a remote picture: nothing is fetched until the
      // writer clicks, so the address a page or a model chose is never requested on a paste.
      if (remotePictureSource(src)) return node;
      const alt = node.attrs.alt ? String(node.attrs.alt) : null;
      imports.push({ url: src, alt });
      const marks = linkType ? [...node.marks, linkType.create({ href: src })] : node.marks;
      return schema.text(src, marks);
    }
    if (node.content.size === 0) return node;
    return node.copy(Fragment.fromArray(node.content.content.map(mapNode)));
  };

  return {
    slice: new Slice(
      Fragment.fromArray(slice.content.content.map(mapNode)),
      slice.openStart,
      slice.openEnd,
    ),
    imports,
  };
}

export function pastedContentRange(transaction: Transaction): AnchorRange | null {
  let from = Number.POSITIVE_INFINITY;
  let to = -1;
  transaction.steps.forEach((step, index) => {
    const rest = transaction.mapping.slice(index + 1);
    step.getMap().forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      from = Math.min(from, rest.map(newFrom, -1));
      to = Math.max(to, rest.map(newTo, 1));
    });
  });
  return to < 0 ? null : { from, to };
}

export function pastedImageLinkRange(
  doc: PMNode,
  range: AnchorRange,
  url: string,
): AnchorRange | null {
  const linkType = doc.type.schema.marks.link;
  if (!linkType) return null;
  const from = Math.max(0, Math.min(range.from, doc.content.size));
  const to = Math.max(from, Math.min(range.to, doc.content.size));

  let found: AnchorRange | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (!node.isText || node.text !== url) return true;
    const link = node.marks.find(
      (mark) => mark.type === linkType && String(mark.attrs.href ?? "") === url,
    );
    if (link) found = { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return found;
}

const PASTED_IMAGE_NAME = "pasted image";

/**
 * Past this, the last segment of an address is a token rather than a name —
 * a signed URL ends in a base64 blob, and handing that to the upload as a
 * filename is how a real one came back `ENAMETOOLONG`.
 */
const PASTED_NAME_LIMIT = 64;

export function imageFilenameFromUrl(url: string): string {
  try {
    const address = new URL(url, "https://pasted.invalid");
    // Only an address with a path has a last segment to read: `data:` carries
    // the bytes themselves, and its "path" is the media type.
    if (address.protocol !== "http:" && address.protocol !== "https:") return PASTED_IMAGE_NAME;
    const last = address.pathname.split("/").filter(Boolean).at(-1);
    if (last) return boundedImageName(decodeURIComponent(last));
  } catch {
    // An address the URL parser refuses is still an image the writer pasted.
  }
  return PASTED_IMAGE_NAME;
}

function boundedImageName(name: string): string {
  if (name.length <= PASTED_NAME_LIMIT) return name;
  const parsed = parseDocumentFilename(name);
  const extension = parsed.ok && parsed.value.extension ? `.${parsed.value.extension}` : "";
  return PASTED_IMAGE_NAME + extension;
}

export function assetDocumentIdFromSrc(src: string): string | null {
  return src.startsWith("asset:") && src.length > 6 ? src.slice(6) : null;
}

const INLINE_PICTURE_SOURCE = /^data:image\//i;

/**
 * A picture source the browser may draw as written, or null: an image `data:` URL, which
 * fetches nothing. An `asset:` upload or a document address names a document that only a signed
 * URL draws, and anything else (`/map.png`, `../map.png`, a malformed scheme) would be fetched
 * from the app's own origin. A web address is `remotePictureSource`'s: it shows a placeholder
 * until the writer loads it.
 */
export function inlinePictureSource(src: string): string | null {
  return INLINE_PICTURE_SOURCE.test(src) ? src : null;
}

export function signedUrlRefreshDelayMs(signedUrlExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(signedUrlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return 60_000;
  const refreshAtMs = expiresAtMs - 30_000;
  return refreshAtMs <= nowMs ? 0 : Math.max(5_000, refreshAtMs - nowMs);
}
