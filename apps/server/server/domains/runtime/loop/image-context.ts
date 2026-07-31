/** Request-time projection of durable image references into canonical gateway ImageParts. */

import type { Block, PersistedImageReference, Thread } from "@meridian/contracts/threads";
import type { ImageAssetPort } from "../ports/image-asset.js";

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
  const projected: Block[] = [];
  for (const block of input.blocks) {
    if (block.blockType !== "image") {
      projected.push(block);
      continue;
    }
    if (!input.supportsImageInput) continue;
    const reference = imageReference(block.content);
    if (!reference) continue;
    const image = await input.imageAssets.resolve(
      { threadId: input.thread.id, projectId: input.thread.projectId },
      reference,
    );
    if (!image) continue;
    projected.push({
      ...block,
      content: {
        type: "image",
        mediaType: image.mediaType,
        data: image.data instanceof URL ? image.data.href : image.data,
      },
    });
  }
  return projected;
}
