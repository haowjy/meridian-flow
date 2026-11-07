/**
 * Converts real images through the real worker pool. The worker is started by file path, so no
 * other test would notice it failing to load (it broke unseen in `nitro dev`).
 */
import { encode } from "bmp-ts";
import sharp from "sharp";
import { expect, it } from "vitest";
import { makeImagePreview } from "./image-preview.js";

const webp = (bytes: Uint8Array | null) =>
  sharp(bytes ?? new Uint8Array())
    .metadata()
    .then((meta) => meta.format);

it("converts a TIFF to WebP", async () => {
  const tiff = await sharp({
    create: { width: 8, height: 6, channels: 3, background: "#c33" },
  })
    .tiff()
    .toBuffer();
  expect(await webp(await makeImagePreview(tiff))).toBe("webp");
});

it("converts a BMP to WebP", async () => {
  const data = Buffer.alloc(8 * 6 * 4, 255);
  const bmp = encode({ data, width: 8, height: 6 }).data;
  expect(await webp(await makeImagePreview(bmp))).toBe("webp");
});

it("rejects a truncated file with a safe reason code", async () => {
  const tiff = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#c33" } })
    .tiff()
    .toBuffer();
  await expect(makeImagePreview(tiff.subarray(0, tiff.length - 40))).rejects.toMatchObject({
    reason: "decode_failed",
  });
});
