import type { Block, Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { ImageAssetPort } from "../ports/image-asset.js";
import { projectImageBlocksForModel } from "./image-context.js";

const thread: Pick<Thread, "id" | "projectId" | "userId"> = {
  id: "thread-1",
  projectId: "project-1",
  userId: "user-1",
};

const imageBlock: Block = {
  id: "image-1",
  turnId: "turn-1",
  responseId: null,
  blockType: "image",
  sequence: 0,
  content: {
    type: "image_reference",
    documentId: "document-1",
    uri: "scratch://image.png",
  },
  createdAt: "2026-09-27T12:00:00.000Z",
};

const missingImageAsset: ImageAssetPort = {
  async resolve() {
    return null;
  },
};

describe("projectImageBlocksForModel", () => {
  it("names a missing asset according to whether it was previously included", async () => {
    const previouslyIncluded = await projectImageBlocksForModel({
      thread,
      blocks: [imageBlock],
      inclusions: new Map([[imageBlock.id, true]]),
      supportsImageInput: true,
      imageAssets: missingImageAsset,
    });
    const firstSight = await projectImageBlocksForModel({
      thread,
      blocks: [imageBlock],
      supportsImageInput: true,
      imageAssets: missingImageAsset,
    });

    expect(previouslyIncluded.breaks).toEqual([
      {
        blockId: imageBlock.id,
        uri: "scratch://image.png",
        reason: "asset_unavailable",
      },
    ]);
    expect(firstSight.breaks).toEqual([
      {
        blockId: imageBlock.id,
        uri: "scratch://image.png",
        reason: "asset_unavailable_first_sight",
      },
    ]);
  });
});
