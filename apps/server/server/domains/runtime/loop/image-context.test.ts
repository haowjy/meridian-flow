/** Late image capability, budget, order, and read-deduplication behavior. */
import type { Block } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { MAX_MODEL_IMAGE_BYTES, projectImageBlocksForModel } from "./image-context.js";

const image = (id: string, sequence: number): Block => ({
  id,
  turnId: "turn",
  responseId: null,
  blockType: "image",
  sequence,
  content: { type: "image_reference", documentId: "doc", uri: "uploads://@/map.png" },
  createdAt: "2026-08-30T00:00:00.000Z",
});
const text: Block = {
  id: "text",
  turnId: "turn",
  responseId: null,
  blockType: "text",
  sequence: 0,
  textContent: "keep me",
  content: "keep me",
  createdAt: "2026-08-30T00:00:00.000Z",
};

describe("late image projection", () => {
  it("never vetoes text for capability or missing bytes", async () => {
    const resolve = vi.fn(async () => null);
    await expect(
      projectImageBlocksForModel({
        thread: { id: "thread", projectId: "project", userId: "user" },
        blocks: [text, image("image", 1)],
        supportsImageInput: false,
        imageAssets: { resolve },
      }),
    ).resolves.toEqual([text]);
    expect(resolve).not.toHaveBeenCalled();
    await expect(
      projectImageBlocksForModel({
        thread: { id: "thread", projectId: "project", userId: "user" },
        blocks: [text, image("image", 1)],
        supportsImageInput: true,
        imageAssets: { resolve },
      }),
    ).resolves.toEqual([text]);
  });

  it("preserves occurrences, reads identity once, and accounts each occurrence against budget", async () => {
    const resolve = vi.fn(async () => ({
      mediaType: "image/png",
      data: "bytes",
      sizeBytes: MAX_MODEL_IMAGE_BYTES,
    }));
    const projected = await projectImageBlocksForModel({
      thread: { id: "thread", projectId: "project", userId: "user" },
      blocks: [image("old", 0), image("middle", 1), image("new", 2)],
      supportsImageInput: true,
      imageAssets: { resolve },
    });
    expect(projected.map((block) => block.id)).toEqual(["middle", "new"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
