/**
 * Worker thread that converts one image to a WebP preview, so the synchronous HEIC (libheif
 * WASM) and BMP decoders and libvips never run on the server's event loop. Plain `.mjs` so Node
 * loads it as-is in dev and the production build can copy it unbundled (see `nitro.config.ts`);
 * it imports only packages. `image-preview.ts` owns the pool and the message protocol:
 * `{ id, mime, bytes }` in, `{ id, preview }` or `{ id, reason }` (`too_large` | `decode_failed`) out.
 */
import { parentPort } from "node:worker_threads";
import { decode as decodeBmp } from "bmp-ts";
import decodeHeic from "heic-decode";
import sharp from "sharp";

const PREVIEW_MAX_DIMENSION = 2048;
const PREVIEW_QUALITY = 85;
/** Refuses decompression bombs before any decoder allocates for them. */
const MAX_INPUT_PIXELS = 50_000_000;

class TooLarge extends Error {}

/** BMP dimensions from the header alone: a 15 MB 1-bit file can claim hundreds of megapixels. */
function bmpPixelCount(bytes) {
  if (bytes.length < 26) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(14, true) === 12) return view.getUint16(18, true) * view.getUint16(20, true);
  return Math.abs(view.getInt32(18, true)) * Math.abs(view.getInt32(22, true));
}

/** Pixels (or the sharp pipeline input) for `bytes`; throws `TooLarge` over the cap. */
async function toPipeline(mime, bytes) {
  if (mime.startsWith("image/heic") || mime.startsWith("image/heif")) {
    const images = await decodeHeic.all({ buffer: bytes });
    try {
      const [first] = images;
      if (first.width * first.height > MAX_INPUT_PIXELS) throw new TooLarge();
      const { data, width, height } = await first.decode();
      return sharp(data, { raw: { width, height, channels: 4 } });
    } finally {
      images.dispose();
    }
  }
  if (mime === "image/bmp") {
    if (bmpPixelCount(bytes) > MAX_INPUT_PIXELS) throw new TooLarge();
    const { data, width, height } = decodeBmp(Buffer.from(bytes), { toRGBA: true });
    // BMP writes alpha 0 for 24-bit pixels, so the channel means nothing.
    return sharp(data, { raw: { width, height, channels: 4 } }).removeAlpha();
  }
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
}

parentPort.on("message", async ({ id, mime, bytes }) => {
  try {
    const pipeline = await toPipeline(mime, bytes);
    const preview = await pipeline
      .resize({
        width: PREVIEW_MAX_DIMENSION,
        height: PREVIEW_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer();
    parentPort.postMessage({ id, preview });
  } catch (error) {
    // sharp's own cap error for TIFF and other formats it decodes.
    const tooLarge = error instanceof TooLarge || /pixel limit/i.test(String(error?.message));
    parentPort.postMessage({ id, reason: tooLarge ? "too_large" : "decode_failed" });
  }
});
