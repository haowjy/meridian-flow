/** Shared helpers for uploaded editor images and asset-backed rendering. */
import type { UploadFigureAssetResponse } from "@meridian/contracts/protocol";

export function isImageFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("image/") || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name);
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

export function assetDocumentIdFromSrc(src: string): string | null {
  return src.startsWith("asset:") && src.length > 6 ? src.slice(6) : null;
}

export function signedUrlRefreshDelayMs(signedUrlExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(signedUrlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return 60_000;
  const refreshAtMs = expiresAtMs - 30_000;
  return refreshAtMs <= nowMs ? 0 : Math.max(5_000, refreshAtMs - nowMs);
}
