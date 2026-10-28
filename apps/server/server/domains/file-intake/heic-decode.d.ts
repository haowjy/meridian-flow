/** `heic-decode` ships no types: decodes a HEIC/HEIF buffer to raw RGBA pixels. */
declare module "heic-decode" {
  export default function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<{
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }>;
}
