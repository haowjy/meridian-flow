/**
 * How big the picture is, asked of the file the writer just handed over.
 *
 * This is what makes the placeholder's slot the picture's real slot: the frame
 * takes the file's own proportions, so when the bytes land the manuscript does
 * not move a line (§5.6). The bytes are already on this machine, so the answer
 * costs no network and arrives in a frame or two.
 *
 * Null is a real answer and not a failure: an SVG without intrinsic dimensions
 * has none, and a browser may decline to decode a file it cannot read. The
 * placeholder then uses its default shape, which is the one case where
 * completion can still shift the line.
 */
export type ImageSize = { width: number; height: number };

export async function measureImageFile(file: Blob): Promise<ImageSize | null> {
  const decoded = await decodeSize(file);
  if (!decoded || decoded.width <= 0 || decoded.height <= 0) return null;
  return decoded;
}

async function decodeSize(file: Blob): Promise<ImageSize | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // A format `createImageBitmap` refuses (SVG in some browsers) may still
      // decode as an <img>, so fall through rather than giving up.
    }
  }
  return decodeWithImageElement(file);
}

function decodeWithImageElement(file: Blob): Promise<ImageSize | null> {
  if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const settle = (size: ImageSize | null) => {
      URL.revokeObjectURL(url);
      resolve(size);
    };
    image.onload = () => settle({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => settle(null);
    image.src = url;
  });
}
