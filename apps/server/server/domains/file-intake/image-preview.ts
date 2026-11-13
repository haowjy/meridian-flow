/**
 * The one function that makes a browser-drawable preview of a saved image, and the one that
 * stores it. Every save path calls `saveImagePreview` after putting the original; a file that
 * gets no preview is drawn as a file card, so a failure here never fails the save.
 *
 * Conversion runs in `image-preview-worker.ts` on a small worker pool (`sharp` for TIFF,
 * `heic-decode` (libheif WASM) for HEIC/HEIF, `bmp-ts` for BMP): the WASM and BMP decoders are
 * synchronous and would freeze every request for seconds. A worker that crashes, runs out of
 * memory or hangs is replaced and its file gets the card.
 */
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
  putDerivedObject,
} from "../storage/index.js";
import { sniffMime } from "./index.js";
import { createWorkerPool, WorkerPoolError } from "./worker-pool.js";

export const PREVIEW_MIME_TYPE = "image/webp";

/**
 * Formats the worker can convert. Other non-drawable images (EMF, WMF, ICO, PSD, ...) have no
 * decoder, so they get the card without an attempt that could only fail.
 */
const CONVERTIBLE = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "image/bmp",
  "image/tiff",
]);

/**
 * Largest original a preview is made from. The decoder needs the whole file in memory, so a
 * bigger convertible picture keeps its original and is drawn as a file card.
 */
export const PREVIEW_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

/** Whether the file starting with `head` is a format a browser can't draw and the worker can convert. */
export async function needsPreviewConversion(head: Uint8Array): Promise<boolean> {
  const mime = await sniffMime(head);
  return mime !== null && CONVERTIBLE.has(mime);
}

/** Why a preview was not made, safe to log: never a decoder message or file content. */
export type ImagePreviewFailureReason =
  | "worker_unavailable"
  | "timeout"
  | "decode_failed"
  | "too_large";

class ImagePreviewError extends Error {
  constructor(readonly reason: ImagePreviewFailureReason) {
    super(`image preview failed: ${reason}`);
  }
}

/** A decode that outlives this is stuck; its worker is replaced and the file gets the card. */
const JOB_TIMEOUT_MS = 60_000;

export type PreviewJob = { mime: string; bytes: Uint8Array };
export type PreviewReply = { preview: Uint8Array } | { reason: "decode_failed" | "too_large" };

const pool = createWorkerPool<PreviewJob, PreviewReply>({
  entry: new URL("./image-preview-worker.ts", import.meta.url),
  size: 2,
  // Pixel buffers live outside the heap and are bounded by the pixel cap.
  maxOldGenerationSizeMb: 256,
  // libheif's WASM module may be left unusable by a failed decode, so a HEIC error retires the
  // worker; the next job starts a fresh one.
  retireAfter: (job, reply) =>
    "reason" in reply && reply.reason === "decode_failed" && job.mime.startsWith("image/hei"),
});

async function convertInWorker(mime: string, bytes: Uint8Array): Promise<Uint8Array> {
  let reply: PreviewReply;
  try {
    reply = await pool.run({ mime, bytes }, JOB_TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof WorkerPoolError)) throw error;
    throw new ImagePreviewError(
      error.reason === "unavailable"
        ? "worker_unavailable"
        : error.reason === "timeout"
          ? "timeout"
          : "decode_failed",
    );
  }
  if ("reason" in reply) throw new ImagePreviewError(reply.reason);
  return new Uint8Array(reply.preview);
}

/**
 * A WebP preview of `bytes`, or null when the format needs none (a browser draws it) or has no
 * decoder. Conversion runs in a worker thread, never on the event loop. Rejects with an
 * `ImagePreviewError` for a decoder failure, a dead worker or an image over the pixel cap,
 * which `saveImagePreview` absorbs.
 */
export async function makeImagePreview(bytes: Uint8Array): Promise<Uint8Array | null> {
  const mime = await sniffMime(bytes);
  if (!mime || !CONVERTIBLE.has(mime)) return null;
  return convertInWorker(mime, bytes);
}

/**
 * Makes and stores the preview beside the original at `storageUrl`. Returns whether a preview
 * now exists, which the caller records as the document's `has_preview`. Never throws.
 */
export async function saveImagePreview(input: {
  objectStore: Pick<ObjectStorePort, "put" | "readHead" | "delete">;
  storageUrl: string;
  bytes: Uint8Array;
  onFailure?: (reason: ImagePreviewFailureReason) => void;
}): Promise<boolean> {
  try {
    const key = objectStoreKeyFromStorageUrl(input.storageUrl);
    if (!key) return false;
    const preview = await makeImagePreview(input.bytes);
    if (!preview) return false;
    const stored = await putDerivedObject(input.objectStore, {
      originalKey: key,
      key: previewObjectKey(key),
      bytes: preview,
      mimeType: PREVIEW_MIME_TYPE,
    });
    if (!stored) throw new Error("The preview was not stored");
    return true;
  } catch (error) {
    input.onFailure?.(error instanceof ImagePreviewError ? error.reason : "decode_failed");
    return false;
  }
}
