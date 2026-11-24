import type { AdmittedMessageBlock, UserMessageBlock } from "@meridian/contracts/protocol";
import type { ResolvedMedia } from "../../ports/media-resolver.js";

export function bytesMedia(input: {
  data: string;
  sizeBytes: number;
  mediaType?: string;
  name?: string;
}): ResolvedMedia {
  return {
    mediaType: input.mediaType ?? "image/png",
    sizeBytes: input.sizeBytes,
    name: input.name ?? "image.png",
    source: async () => ({ data: input.data }),
  };
}

export function admitted(blocks: readonly UserMessageBlock[]): AdmittedMessageBlock[] {
  return blocks.map((block) =>
    block.type === "image"
      ? { ...block, mediaType: "image/png", sizeBytes: 5, name: block.uri.split("/").at(-1) ?? "" }
      : block,
  );
}
