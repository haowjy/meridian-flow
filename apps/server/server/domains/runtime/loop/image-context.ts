/** Request-time projection of durable image references into canonical gateway ImageParts. */

import type { Block, PersistedImageReference, Thread } from "@meridian/contracts/threads";
import type { ImageAssetPort } from "../ports/image-asset.js";

export const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;

function imageReference(content: Block["content"]): PersistedImageReference | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  if (
    content.type !== "image_reference" ||
    typeof content.documentId !== "string" ||
    typeof content.uri !== "string"
  ) {
    return null;
  }
  return {
    type: "image_reference",
    documentId: content.documentId,
    uri: content.uri,
  };
}

export async function projectImageBlocksForModel(input: {
  thread: Pick<Thread, "id" | "projectId">;
  blocks: readonly Block[];
  supportsImageInput: boolean;
  imageAssets: ImageAssetPort;
}): Promise<Block[]> {
  if (!input.supportsImageInput) {
    return input.blocks.filter((block) => block.blockType !== "image");
  }

  const resolvedByReference = new Map<string, Awaited<ReturnType<ImageAssetPort["resolve"]>>>();
  const projectedByIndex = new Map<number, Block>();
  let remainingBytes = MAX_MODEL_IMAGE_CONTEXT_BYTES;

  // Newest references win the bounded request budget. Historical images remain
  // eligible only while space remains, and duplicate references share one object read.
  for (let index = input.blocks.length - 1; index >= 0 && remainingBytes > 0; index--) {
    const block = input.blocks[index];
    if (block?.blockType !== "image" || block.pruned) continue;
    const reference = imageReference(block.content);
    if (!reference) continue;
    const key = `${reference.documentId}\0${reference.uri}`;
    let image = resolvedByReference.get(key);
    if (image === undefined) {
      image = await input.imageAssets.resolve(
        { threadId: input.thread.id, projectId: input.thread.projectId },
        reference,
        { maxBytes: Math.min(MAX_MODEL_IMAGE_BYTES, remainingBytes) },
      );
      resolvedByReference.set(key, image);
    }
    if (!image || image.sizeBytes > remainingBytes) continue;
    remainingBytes -= image.sizeBytes;
    projectedByIndex.set(index, {
      ...block,
      content: {
        type: "image",
        mediaType: image.mediaType,
        data: image.data instanceof URL ? image.data.href : image.data,
      },
    });
  }

  return input.blocks.flatMap((block, index) => {
    if (block.blockType !== "image") return [block];
    const projected = projectedByIndex.get(index);
    return projected ? [projected] : [];
  });
}
