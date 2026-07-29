/** Shared helpers for uploaded editor images and asset-backed rendering. */
import type { UploadFigureAssetResponse } from "@meridian/contracts/protocol";
import { Fragment, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

import type { AnchorRange } from "./anchors";

export function isImageFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name);
}

/**
 * What a drop carrying files means.
 *
 * The editor answers for every file dropped on it, including the ones it
 * cannot use: the browser's own answer to an unclaimed file is to LEAVE the
 * page and open it, which takes the writer out of the manuscript
 * mid-sentence. Null is the only case the editor has nothing to say about —
 * a drop carrying no files at all, which is ProseMirror's own business.
 */
export type FileDropIntent =
  | { kind: "insert"; file: File }
  /** Named, because a refusal that does not say what it refused is a shrug. */
  | { kind: "refuse"; filename: string };

export function fileDropIntent(files: readonly File[]): FileDropIntent | null {
  if (files.length === 0) return null;
  const image = files.find(isImageFile);
  return image ? { kind: "insert", file: image } : { kind: "refuse", filename: files[0].name };
}

export function imageAltFromFilename(filename: string): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return stem || filename || "Image";
}

export function imageAttrsFromUpload(response: UploadFigureAssetResponse) {
  return {
    src: `asset:${response.assetDocumentId}`,
    alt: response.figure.alt || null,
    title: null,
  };
}

export type MutableAssetPathResolver = import("@meridian/markup").AssetPathResolver & {
  remember(assetDocumentId: string, path: string): void;
};

export function createEditorAssetPathResolver(): MutableAssetPathResolver {
  const pathById = new Map<string, string>();
  const idByPath = new Map<string, string>();
  return {
    remember(assetDocumentId, path) {
      pathById.set(assetDocumentId, path);
      idByPath.set(path, assetDocumentId);
    },
    pathForAsset(assetDocumentId) {
      const path = pathById.get(assetDocumentId);
      if (!path) throw new Error(`No project-relative path for asset:${assetDocumentId}`);
      return path;
    },
    assetForPath(path) {
      return idByPath.get(path) ?? null;
    },
  };
}

export function resolveAssetRefsForClipboard(
  slice: Slice,
  resolver: import("@meridian/markup").AssetPathResolver,
): Slice {
  const mapNode = (node: PMNode): PMNode => {
    if (node.type.name === "image") {
      const src = String(node.attrs.src ?? "");
      if (!src.startsWith("asset:")) return node;
      return node.type.create(
        { ...node.attrs, src: resolver.pathForAsset(src.slice("asset:".length)) },
        null,
        node.marks,
      );
    }
    return node.copy(Fragment.fromArray(node.content.content.map(mapNode)));
  };
  return new Slice(
    Fragment.fromArray(slice.content.content.map(mapNode)),
    slice.openStart,
    slice.openEnd,
  );
}

function resolveAssetPathsFromClipboard(
  slice: Slice,
  resolver: import("@meridian/markup").AssetPathResolver,
): Slice {
  const mapNode = (node: PMNode): PMNode => {
    if (node.type.name === "image") {
      const src = String(node.attrs.src ?? "");
      const assetDocumentId = resolver.assetForPath(src);
      if (!assetDocumentId) return node;
      return node.type.create({ ...node.attrs, src: `asset:${assetDocumentId}` }, null, node.marks);
    }
    return node.copy(Fragment.fromArray(node.content.content.map(mapNode)));
  };
  return new Slice(
    Fragment.fromArray(slice.content.content.map(mapNode)),
    slice.openStart,
    slice.openEnd,
  );
}

/**
 * What a paste may do with the images it carries — the one seam, so there is
 * one answer to "which pictures can land here".
 *
 * Two kinds arrive. A picture copied from another Meridian document travels as
 * a project-relative path and comes home as the stable ref it left as. Anything
 * else is an address the project does not own, and it lands as a link until it
 * has been imported.
 */
export function resolveImagesFromClipboard(
  slice: Slice,
  schema: Schema,
  resolver: import("@meridian/markup").AssetPathResolver,
): { slice: Slice; imports: PastedImageImport[] } {
  return linkExternalPastedImages(resolveAssetPathsFromClipboard(slice, resolver), schema);
}

/**
 * An image the clipboard only pointed at, waiting to become an asset.
 *
 * `url` is both the address to fetch and the text of the link standing in for
 * the picture until the import lands, which is how the writer can see what
 * they pasted while it is on its way.
 */
export type PastedImageImport = {
  url: string;
  alt: string | null;
};

/**
 * Every image in a pasted slice that the manuscript cannot hold, turned into a
 * link to itself.
 *
 * An image's `src` is a stable `asset:<documentId>` and nothing else. Web HTML
 * carries `<img src="https://…">`, and admitting one writes an address the
 * project does not own into the shared document: it expires, it leaks where
 * the writer was reading, and it renders as a broken figure the moment the
 * host says no. So the paste never lands a picture it has not imported — it
 * lands the address, as a link, and the import that follows replaces the link
 * with the picture. Where the import cannot happen, the link is already the
 * right answer and nothing has to be undone.
 *
 * A `data:` image is treated the same way, ugly link text and all: it is the
 * rare door (the clipboard's own file item wins for a copied picture), the
 * import nearly always succeeds, and the alternative is base64 on the wire.
 */
function linkExternalPastedImages(
  slice: Slice,
  schema: Schema,
): { slice: Slice; imports: PastedImageImport[] } {
  const imports: PastedImageImport[] = [];
  const linkType = schema.marks.link ?? null;

  const mapNode = (node: PMNode): PMNode => {
    if (node.type.name === "image") {
      const src = String(node.attrs.src ?? "");
      if (!src || src.startsWith("asset:")) return node;
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

/**
 * Where a paste put its content, in the document the transaction produced.
 *
 * The import that follows a paste has to find the link it left behind, and the
 * paste itself is the only thing that knows where that is: the slice arrives
 * before the transaction exists, and the selection afterwards says only where
 * the content ended. Each step's own map is walked forward through the steps
 * after it, so the answer is in final-document coordinates.
 */
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

/**
 * The link a paste left in place of `url`, or null when it is gone — the
 * writer may have deleted or rewritten it while the import was in flight, and
 * an import with nowhere to land does nothing rather than guessing.
 */
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
 * A filename for an image the writer never named: the last segment of its
 * address, which is what they would have seen had they saved it.
 */
export function imageFilenameFromUrl(url: string): string {
  try {
    const address = new URL(url, "https://pasted.invalid");
    // Only an address with a path has a last segment to read: `data:` carries
    // the bytes themselves, and its "path" is the media type.
    if (address.protocol !== "http:" && address.protocol !== "https:") return PASTED_IMAGE_NAME;
    const last = address.pathname.split("/").filter(Boolean).at(-1);
    if (last) return decodeURIComponent(last);
  } catch {
    // An address the URL parser refuses is still an image the writer pasted.
  }
  return PASTED_IMAGE_NAME;
}

export function assetDocumentIdFromSrc(src: string): string | null {
  return src.startsWith("asset:") && src.length > 6 ? src.slice(6) : null;
}

export function signedUrlRefreshDelayMs(signedUrlExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(signedUrlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return 60_000;
  const refreshAtMs = expiresAtMs - 30_000;
  return refreshAtMs <= nowMs ? 0 : Math.max(5_000, refreshAtMs - nowMs);
}
