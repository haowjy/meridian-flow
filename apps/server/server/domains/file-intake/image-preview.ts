import { createWorkerPool, WorkerPoolError } from "../../shared/worker-pool.js";
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
  putDerivedObject,
} from "../storage/index.js";
import { sniffMime } from "./index.js";

export const PREVIEW_MIME_TYPE = "image/webp";

const CONVERTIBLE = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "image/bmp",
  "image/tiff",
]);

export const PREVIEW_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

export async function needsPreviewConversion(head: Uint8Array): Promise<boolean> {
  const mime = await sniffMime(head);
  return mime !== null && CONVERTIBLE.has(mime);
}

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

const JOB_TIMEOUT_MS = 60_000;

export type PreviewJob = { mime: string; bytes: Uint8Array };
export type PreviewReply = { preview: Uint8Array } | { reason: "decode_failed" | "too_large" };

const pool = createWorkerPool<PreviewJob, PreviewReply>({
  entry: new URL("./image-preview-worker.ts", import.meta.url),
  size: 2,
  maxOldGenerationSizeMb: 256,
  // keep: Retire a worker after a HEIC decode failure; libheif's WASM may be unusable
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

export async function makeImagePreview(bytes: Uint8Array): Promise<Uint8Array | null> {
  const mime = await sniffMime(bytes);
  if (!mime || !CONVERTIBLE.has(mime)) return null;
  return convertInWorker(mime, bytes);
}

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
