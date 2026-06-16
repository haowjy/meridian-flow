/**
 * figure-workflow — pure helpers for the editor's figure upload/insert flow.
 *
 * Image-file detection, default alt/caption derivation from filenames, mapping
 * an upload response to figure node attrs, and signed-URL refresh timing. No
 * React or editor state; shared by `EditorView` and `FigureNodeView`.
 */
import type { FigureNodeReference, UploadFigureAssetResponse } from "@meridian/contracts/protocol";

export type FigureNodeAttrs = {
  src: string;
  alt: string | null;
  label: string | null;
  caption: string;
};

export function isImageFile(file: Pick<File, "type" | "name">): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name);
}

export function figureDefaultAltFromFilename(filename: string): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return stem || filename || "Figure";
}

export function figureUploadDefaults(file: Pick<File, "name">): {
  alt: string;
  caption: string;
} {
  return {
    alt: figureDefaultAltFromFilename(file.name),
    caption: "",
  };
}

export function figureNodeAttrsFromReference(reference: FigureNodeReference): FigureNodeAttrs {
  return {
    src: reference.src,
    alt: reference.alt || null,
    label: reference.label,
    caption: reference.caption ?? "",
  };
}

export function uploadResponseToFigureNodeAttrs(
  response: UploadFigureAssetResponse,
): FigureNodeAttrs {
  return figureNodeAttrsFromReference(response.figure);
}

export function isObjectStoreFigureSrc(src: string): boolean {
  return src.startsWith("object://");
}

export function signedUrlRefreshDelayMs(signedUrlExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(signedUrlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return 60_000;

  const refreshAtMs = expiresAtMs - 30_000;
  if (refreshAtMs <= nowMs) return 0;
  return Math.max(5_000, refreshAtMs - nowMs);
}
