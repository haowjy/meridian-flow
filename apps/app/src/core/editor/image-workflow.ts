/** Shared helpers for uploaded editor images and asset-backed rendering. */
import type { UploadFigureAssetResponse } from "@meridian/contracts/protocol";
import { Fragment, type Node as PMNode, Slice } from "@tiptap/pm/model";

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

export function resolveAssetPathsFromClipboard(
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

export function assetDocumentIdFromSrc(src: string): string | null {
  return src.startsWith("asset:") && src.length > 6 ? src.slice(6) : null;
}

export function signedUrlRefreshDelayMs(signedUrlExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(signedUrlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return 60_000;
  const refreshAtMs = expiresAtMs - 30_000;
  return refreshAtMs <= nowMs ? 0 : Math.max(5_000, refreshAtMs - nowMs);
}
