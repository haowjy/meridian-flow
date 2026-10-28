/**
 * The one function that makes a browser-drawable preview of a saved image, and the one that
 * stores it. Every save path calls `saveImagePreview` after putting the original; a file that
 * gets no preview is drawn as a file card, so a failure here never fails the save.
 *
 * Decoders by format (verified against the bundled libvips, which has no HEVC and no BMP):
 * `sharp` for TIFF and other libvips formats, `heic-decode` (libheif WASM, has HEVC) for
 * HEIC/HEIF, `bmp-ts` for BMP. EMF/WMF have no maintained pure-JS renderer; they get the card.
 */
/// <reference path="./heic-decode.d.ts" />
import { decode as decodeBmp } from "bmp-ts";
import decodeHeic from "heic-decode";
import sharp, { type Sharp } from "sharp";
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  previewObjectKey,
} from "../storage/index.js";
import { sniffMime } from "./index.js";

export const PREVIEW_MIME_TYPE = "image/webp";
/** Longest side of a preview; originals stay full size and downloadable. */
const PREVIEW_MAX_DIMENSION = 2048;
const PREVIEW_QUALITY = 85;
/** Refuses decompression bombs before libvips allocates for them. */
const MAX_INPUT_PIXELS = 120_000_000;

/** Formats every supported browser draws from the original. */
const BROWSER_DRAWABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

type RawPixels = {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** The decoder's alpha channel means nothing (BMP writes 0 for 24-bit pixels). */
  ignoreAlpha?: boolean;
};

async function decodeRaw(mime: string, bytes: Uint8Array): Promise<RawPixels | null> {
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence") {
    const image = await decodeHeic({ buffer: bytes });
    return { data: image.data, width: image.width, height: image.height };
  }
  if (mime === "image/bmp") {
    const image = decodeBmp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      toRGBA: true,
    });
    return { data: image.data, width: image.width, height: image.height, ignoreAlpha: true };
  }
  return null;
}

function fromRaw(raw: RawPixels): Sharp {
  const image = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
  return raw.ignoreAlpha ? image.removeAlpha() : image;
}

/**
 * A WebP preview of `bytes`, or null when the format needs none (a browser draws it) or cannot
 * be converted (unknown format, corrupt file). Throws only for a decoder failure, which
 * `saveImagePreview` absorbs.
 */
export async function makeImagePreview(bytes: Uint8Array): Promise<Uint8Array | null> {
  const mime = await sniffMime(bytes);
  if (!mime || BROWSER_DRAWABLE.has(mime) || !mime.startsWith("image/")) return null;
  const raw = await decodeRaw(mime, bytes);
  if (raw && raw.width * raw.height > MAX_INPUT_PIXELS) return null;
  const pipeline = raw
    ? fromRaw(raw)
    : sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  return pipeline
    .resize({
      width: PREVIEW_MAX_DIMENSION,
      height: PREVIEW_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: PREVIEW_QUALITY })
    .toBuffer();
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
