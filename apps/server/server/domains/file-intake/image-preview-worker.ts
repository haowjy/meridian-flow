import { parentPort } from "node:worker_threads";
import { decode as decodeBmp } from "bmp-ts";
// slop-lint: allow suppression heic-decode has no types to declare
// @ts-expect-error heic-decode ships no type declarations
import decodeHeic from "heic-decode";
import sharp from "sharp";
import type { PreviewJob, PreviewReply } from "./image-preview.js";

const PREVIEW_MAX_DIMENSION = 2048;
const PREVIEW_QUALITY = 85;
const MAX_INPUT_PIXELS = 50_000_000;

class TooLarge extends Error {}

function bmpPixelCount(bytes: Uint8Array): number {
  if (bytes.length < 26) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(14, true) === 12) return view.getUint16(18, true) * view.getUint16(20, true);
  return Math.abs(view.getInt32(18, true)) * Math.abs(view.getInt32(22, true));
}

async function toPipeline(mime: string, bytes: Uint8Array): Promise<ReturnType<typeof sharp>> {
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
    // Remove BMP alpha; 24-bit pixels report alpha 0
    return sharp(data, { raw: { width, height, channels: 4 } }).removeAlpha();
  }
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
}

async function convert({ mime, bytes }: PreviewJob): Promise<PreviewReply> {
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
    return { preview };
  } catch (error) {
    const tooLarge =
      error instanceof TooLarge ||
      /pixel limit/i.test(String((error as Error | undefined)?.message));
    return { reason: tooLarge ? "too_large" : "decode_failed" };
  }
}

parentPort?.on("message", async ({ id, input }: { id: number; input: PreviewJob }) => {
  parentPort?.postMessage({ id, reply: await convert(input) });
});
