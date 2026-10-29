/**
 * The one function that makes a browser-drawable preview of a saved image, and the one that
 * stores it. Every save path calls `saveImagePreview` after putting the original; a file that
 * gets no preview is drawn as a file card, so a failure here never fails the save.
 *
 * Conversion runs in `image-preview-worker.mjs` on a small worker pool (`sharp` for TIFF,
 * `heic-decode` (libheif WASM) for HEIC/HEIF, `bmp-ts` for BMP): the WASM and BMP decoders are
 * synchronous and would freeze every request for seconds. A worker that crashes, runs out of
 * memory or hangs is replaced and its file gets the card.
 */
import { Worker } from "node:worker_threads";
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../storage/index.js";
import { sniffMime } from "./index.js";

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

const POOL_SIZE = 2;
/** A decode that outlives this is stuck; its worker is replaced and the file gets the card. */
const JOB_TIMEOUT_MS = 60_000;
/** Each worker's JS heap cap; pixel buffers live outside it and are bounded by the pixel cap. */
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256 };

type Job = {
  mime: string;
  bytes: Uint8Array;
  resolve(preview: Uint8Array | null): void;
  reject(error: Error): void;
};
type Slot = { worker: Worker; job?: Job & { id: number; timer: NodeJS.Timeout } };

const slots: Slot[] = [];
const queue: Job[] = [];
let nextJobId = 0;

function workerUrl(): URL {
  return new URL("./image-preview-worker.mjs", import.meta.url);
}

/** Ends the slot's job with `outcome` and, if the worker is gone, replaces it. */
function settle(slot: Slot, outcome: { preview: Uint8Array | null } | { error: Error }): void {
  const job = slot.job;
  if (!job) return;
  clearTimeout(job.timer);
  slot.job = undefined;
  if ("error" in outcome) job.reject(outcome.error);
  else job.resolve(outcome.preview);
  pump();
}

function spawnSlot(): Slot {
  const worker = new Worker(workerUrl(), { resourceLimits: WORKER_LIMITS });
  const slot: Slot = { worker };
  worker.on("message", (message: { id: number; preview?: Uint8Array | null; error?: string }) => {
    if (slot.job?.id !== message.id) return;
    settle(
      slot,
      message.error === undefined
        ? { preview: message.preview ? new Uint8Array(message.preview) : null }
        : { error: new Error(message.error) },
    );
  });
  // A crash or out-of-memory kill ends the worker: fail its job and drop the slot; the next job
  // starts a fresh one.
  const onGone = (error: Error) => {
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    settle(slot, { error });
  };
  worker.on("error", onGone);
  worker.on("exit", (code) => onGone(new Error(`image preview worker exited (${code})`)));
  // After the listeners: adding a 'message' listener re-refs the worker. Unreffed, an idle pool
  // never holds the process open; a pending job's timer does.
  worker.unref();
  return slot;
}

function pump(): void {
  while (queue.length > 0) {
    let slot = slots.find((candidate) => !candidate.job);
    if (!slot && slots.length < POOL_SIZE) {
      slot = spawnSlot();
      slots.push(slot);
    }
    const job = queue.shift();
    if (!slot || !job) return;
    const id = nextJobId++;
    const timer = setTimeout(() => {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      settle(slot, { error: new Error("image preview timed out") });
      void slot.worker.terminate();
    }, JOB_TIMEOUT_MS);
    slot.job = { ...job, id, timer };
    slot.worker.postMessage({ id, mime: job.mime, bytes: job.bytes });
  }
}

function convertInWorker(mime: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    queue.push({ mime, bytes, resolve, reject });
    pump();
  });
}

/**
 * A WebP preview of `bytes`, or null when the format needs none (a browser draws it), has no
 * decoder, or is over the pixel cap. Conversion runs in a worker thread, never on the event
 * loop. Rejects for a decoder failure or a dead worker, which `saveImagePreview` absorbs.
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
  objectStore: ObjectStorePort;
  storageUrl: string;
  bytes: Uint8Array;
  onFailure?: (error: unknown) => void;
}): Promise<boolean> {
  try {
    const key = objectStoreKeyFromStorageUrl(input.storageUrl);
    if (!key) return false;
    const preview = await makeImagePreview(input.bytes);
    if (!preview) return false;
    const put = await input.objectStore.put(previewObjectKey(key), preview, PREVIEW_MIME_TYPE);
    if (!put.ok) throw new Error(put.error.message);
    return true;
  } catch (error) {
    input.onFailure?.(error);
    return false;
  }
}
