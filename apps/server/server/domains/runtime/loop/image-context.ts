/** Quiet request-time projection of durable image occurrences into gateway bytes. */
import type { Block, Thread } from "@meridian/contracts/threads";
import type { ImageAssetPort, PersistedImageReference } from "../ports/image-asset.js";

export const MAX_MODEL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MODEL_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;

function reference(content: Block["content"]): PersistedImageReference | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  return content.type === "image_reference" &&
    typeof content.documentId === "string" &&
    typeof content.uri === "string"
    ? { type: "image_reference", documentId: content.documentId, uri: content.uri }
    : null;
}

export async function projectImageBlocksForModel(input: {
  thread: Pick<Thread, "id" | "projectId" | "userId">;
  blocks: readonly Block[];
  supportsImageInput: boolean;
  imageAssets: ImageAssetPort;
}): Promise<Block[]> {
  if (!input.supportsImageInput) {
    if (input.blocks.some((block) => block.blockType === "image")) {
      input.imageAssets.diagnose?.({
        threadId: input.thread.id,
        projectId: input.thread.projectId,
        reason: "model_unsupported",
      });
    }
    return input.blocks.filter((block) => block.blockType !== "image");
  }
  const reads = new Map<string, Awaited<ReturnType<ImageAssetPort["resolve"]>>>();
  const projected = new Map<number, Block>();
  let remaining = MAX_MODEL_IMAGE_CONTEXT_BYTES;
  for (let index = input.blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = input.blocks[index];
    if (block?.blockType !== "image" || block.pruned) continue;
    const identity = reference(block.content);
    if (!identity) continue;
    const key = `${identity.documentId}\0${identity.uri}`;
    let image = reads.get(key);
    if (image === undefined) {
      image = await input.imageAssets.resolve(
        {
          threadId: input.thread.id,
          projectId: input.thread.projectId,
          actorUserId: input.thread.userId,
        },
        identity,
        { maxBytes: Math.min(MAX_MODEL_IMAGE_BYTES, remaining) },
      );
      reads.set(key, image);
    }
    if (!image || image.sizeBytes > remaining) continue;
    remaining -= image.sizeBytes;
    projected.set(index, {
      ...block,
      content: {
        type: "image",
        mediaType: image.mediaType,
        data: image.data instanceof URL ? image.data.href : image.data,
      },
    });
  }
  if (input.blocks.some((block, index) => block.blockType === "image" && !projected.has(index))) {
    input.imageAssets.diagnose?.({
      threadId: input.thread.id,
      projectId: input.thread.projectId,
      reason: "unavailable_or_over_budget",
    });
  }
  return input.blocks.flatMap((block, index) => {
    if (block.blockType !== "image") return [block];
    const modelBlock = projected.get(index);
    return modelBlock ? [modelBlock] : [];
  });
}
